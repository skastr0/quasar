/**
 * INDEPENDENT source parsers for the validation batteries.
 *
 * These deliberately do NOT import the ingest mapping code
 * (packages/cli/src/commands/ingest.ts, packages/core adapters). They are a
 * second, from-scratch implementation of the documented turn-mapping rules in
 * docs/architecture/quasar-data-reality-plan-2026-06-11.md ("Turn-mapping
 * rules per provider"), parsing provider files and SQLite databases directly.
 * If the product's mapping drifts from the documented rules — or these rules
 * drift from the product — reconciliation goes red. That is the point.
 *
 * The only boundary applied is Convex's 1 MiB value limit (a platform
 * property, not an invented budget): a text value at or beyond it is provider
 * garbage and produces zero rows, mirroring the documented boundary-rejection
 * line.
 */
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

/** Convex's 1 MiB value limit — the only rejection line, adopted wholesale. */
export const CONVEX_MAX_VALUE_BYTES = 1_048_576;

export type TurnRole = "user" | "assistant" | "reasoning";

export interface TurnRow {
  readonly seq: number;
  readonly role: TurnRole;
  readonly text: string;
}

export interface SessionParse {
  readonly messages: TurnRow[];
  readonly toolCallCount: number;
  /** Source rows rejected at the 1 MiB boundary (zero rows written for them). */
  readonly rejectedEvents: number;
  /**
   * Rows the DOCUMENTED mapping forbids but the current product is known to
   * emit: machinery part/block envelopes whose only "text" is a JSON dump
   * (e.g. an empty opencode reasoning part stored as an assistant row
   * `{"type":"reasoning"}`, an empty codex output_text item stored as
   * `{"type":"output_text"}`). Counted separately so reconciliation can name
   * the defect precisely instead of reporting an anonymous drift.
   */
  readonly machineryDumpRows: number;
}

export interface ProviderTotals {
  sessions: number;
  messages: number;
  toolCalls: number;
  rejectedEvents: number;
  machineryDumpRows: number;
}

const home = () => process.env.HOME ?? homedir();

export const PROVIDER_ROOTS = {
  claude: () => join(process.env.CLAUDE_CONFIG_DIR ?? join(home(), ".claude"), "projects"),
  codex: () => process.env.CODEX_HOME ?? join(home(), ".codex"),
  opencode: () => join(home(), ".local/share/opencode"),
  hermes: () => process.env.HERMES_HOME ?? join(home(), ".hermes"),
  grok: () => join(home(), ".grok", "sessions"),
  antigravity: () => join(home(), ".gemini", "antigravity-cli", "brain"),
} as const;

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** Whitespace-collapse for compact text comparison (content is never dropped
 * by a heuristic — only the Convex 1 MiB line rejects). */
export const collapse = (value: string): string =>
  value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const stringValue = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Parse a JSONL file: every successfully parsed line in order (invalid lines
 * are skipped; the surviving array index is the event sequence). */
const readJsonLines = (path: string): unknown[] => {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const values: unknown[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      values.push(JSON.parse(line));
    } catch {
      // Skipped exactly like the documented best-effort line reader.
    }
  }
  return values;
};

const collectFiles = (root: string, predicate: (path: string) => boolean): string[] => {
  const files: string[] = [];
  const visit = (path: string) => {
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      return;
    }
    if (predicate(path)) files.push(path);
  };
  if (existsSync(root)) visit(root);
  return files;
};

/**
 * Pushes one turn row per non-empty role bucket, applying the Convex 1 MiB
 * boundary (reasoning first, so same-seq rows read thought-then-reply).
 * Returns the number of boundary rejections.
 */
const pushRows = (
  rows: TurnRow[],
  seq: number,
  role: "user" | "assistant",
  reasoningParts: readonly string[],
  textParts: readonly string[],
): number => {
  let rejected = 0;
  const push = (rowRole: TurnRole, parts: readonly string[]) => {
    if (parts.length === 0) return;
    const text = parts.join("\n\n");
    if (utf8Bytes(text) >= CONVEX_MAX_VALUE_BYTES) {
      rejected += 1;
      return;
    }
    rows.push({ seq, role: rowRole, text });
  };
  push("reasoning", reasoningParts);
  push(role, textParts);
  return rejected;
};

// ---------------------------------------------------------------------------
// claude — ~/.claude/projects/**/*.jsonl
// Documented rules: text blocks of user/assistant messages → messages;
// plaintext thinking blocks → role "reasoning"; tool_use/tool_result →
// toolCalls (deduplicated by native tool id).
// ---------------------------------------------------------------------------

export const claudeSessionFiles = (): string[] =>
  collectFiles(PROVIDER_ROOTS.claude(), (path) => path.endsWith(".jsonl"));

export const parseClaudeSession = (path: string): SessionParse => {
  const rows: TurnRow[] = [];
  const toolIds = new Set<string>();
  let rejected = 0;
  let machineryDumpRows = 0;
  readJsonLines(path).forEach((value, seq) => {
    const record = asRecord(value);
    const message = asRecord(record.message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    for (const blockValue of blocks) {
      const block = asRecord(blockValue);
      if (block.type === "tool_use" && typeof block.id === "string") toolIds.add(block.id);
      if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
        toolIds.add(block.tool_use_id);
      }
    }
    const role =
      typeof message.role === "string"
        ? message.role
        : typeof record.type === "string"
          ? record.type
          : "";
    if (role !== "user" && role !== "assistant") return;
    if (typeof message.content === "string") {
      // String content rides the compact-text path: one row when non-empty.
      const text = collapse(message.content);
      rejected += pushRows(rows, seq, role, [], text.length > 0 ? [text] : []);
      return;
    }
    const reasoningParts: string[] = [];
    const textParts: string[] = [];
    let emptyTextBlocks = 0;
    for (const blockValue of blocks) {
      const block = asRecord(blockValue);
      if (
        block.type === "thinking" &&
        typeof block.thinking === "string" &&
        block.thinking.trim().length > 0
      ) {
        reasoningParts.push(block.thinking);
      }
      if (block.type === "text" && typeof block.text === "string") {
        if (block.text.trim().length > 0) textParts.push(block.text);
        else if (block.text.length === 0) emptyTextBlocks += 1; // dumps as {"type":"text"}
      }
    }
    rejected += pushRows(rows, seq, role, reasoningParts, textParts);
    if (textParts.length === 0 && emptyTextBlocks > 0) machineryDumpRows += 1;
  });
  return { messages: rows, toolCallCount: toolIds.size, rejectedEvents: rejected, machineryDumpRows };
};

// ---------------------------------------------------------------------------
// codex — ~/.codex/sessions/** and ~/.codex/archived_sessions/** rollout JSONL
// Documented rules: response_item records only (event_msg duplicates are never
// ingested); injected wrappers are machine-authored and skipped; encrypted/
// summarized reasoning skipped; function_call/local_shell_call/custom_tool_call
// (+ outputs) → toolCalls keyed by call_id.
// ---------------------------------------------------------------------------

/**
 * The harness-injected wrapper grammar: a message whose first content text
 * opens with one of these (or any `<*_instructions>` bundle tag) was authored
 * by the harness, not a human, and is excluded from the search surface.
 */
const CODEX_INJECTED_PREFIXES = [
  "<environment_context",
  "<user_instructions",
  "<turn_aborted",
  "<ide_context",
  "<skill>",
  "<subagent_notification",
  "<goal_context",
  "<codex_internal_context",
  "<proposed_plan",
  "<collaboration_mode",
  "<personality_spec",
  "<model_switch",
  "<app-context",
  "# AGENTS.md instructions",
] as const;
const CODEX_INJECTED_TAG = /^<[a-z][a-z0-9_-]*[_ ]instructions>/;

const CODEX_TOOL_PAYLOAD_TYPES = new Set([
  "function_call",
  "local_shell_call",
  "custom_tool_call",
  "function_call_output",
  "local_shell_call_output",
  "custom_tool_call_output",
]);

const codexFirstContentText = (payload: Record<string, unknown>): string | undefined => {
  if (typeof payload.content === "string") return payload.content;
  if (!Array.isArray(payload.content)) return undefined;
  for (const block of payload.content) {
    const text = asRecord(block).text;
    if (typeof text === "string") return text;
  }
  return undefined;
};

const codexIsInjectedWrapper = (payload: Record<string, unknown>): boolean => {
  const text = codexFirstContentText(payload)?.trimStart();
  return (
    text !== undefined &&
    (CODEX_INJECTED_PREFIXES.some((prefix) => text.startsWith(prefix)) ||
      CODEX_INJECTED_TAG.test(text))
  );
};

export const codexSessionFiles = (): string[] => {
  const root = PROVIDER_ROOTS.codex();
  return ["sessions", "archived_sessions"].flatMap((directory) =>
    collectFiles(join(root, directory), (path) => /rollout-.*\.jsonl$/.test(path)),
  );
};

const codexImageOrFileItem = (item: Record<string, unknown>): boolean => {
  const type = typeof item.type === "string" ? item.type.toLowerCase() : "";
  return (
    type.includes("image") ||
    type.includes("file") ||
    item.image_url !== undefined ||
    item.imageUrl !== undefined ||
    item.image !== undefined ||
    item.file !== undefined
  );
};

export const parseCodexSession = (path: string): SessionParse & { hasEvents: boolean } => {
  const rows: TurnRow[] = [];
  const toolIds = new Set<string>();
  let rejected = 0;
  let machineryDumpRows = 0;
  const records = readJsonLines(path);
  records.forEach((value, seq) => {
    const record = asRecord(value);
    const payload = asRecord(record.payload);
    const payloadType = typeof payload.type === "string" ? payload.type : undefined;
    if (
      payloadType !== undefined &&
      CODEX_TOOL_PAYLOAD_TYPES.has(payloadType) &&
      typeof payload.call_id === "string" &&
      payload.call_id.length > 0
    ) {
      toolIds.add(payload.call_id);
    }
    if (record.type !== "response_item" || payloadType !== "message") return;
    const role = payload.role;
    if (role !== "user" && role !== "assistant") return;
    if (codexIsInjectedWrapper(payload)) return;
    const textParts: string[] = [];
    let dumpItems = 0;
    if (typeof payload.content === "string") {
      const text = collapse(payload.content);
      if (text.length > 0) textParts.push(text);
    } else if (Array.isArray(payload.content)) {
      for (const item of payload.content) {
        if (typeof item === "string") {
          const compact = collapse(item);
          if (compact.length > 0) textParts.push(compact);
          continue;
        }
        const itemRecord = asRecord(item);
        const text = stringValue(itemRecord.text);
        const compact = text === undefined ? "" : collapse(text);
        if (compact.length > 0) {
          textParts.push(compact);
          continue;
        }
        // An item with no surviving text projects to a JSON envelope dump
        // (e.g. {"type":"output_text"}) in the current product.
        if (!codexImageOrFileItem(itemRecord) && Object.keys(itemRecord).length > 0) {
          dumpItems += 1;
        }
      }
    }
    rejected += pushRows(rows, seq, role, [], textParts);
    if (textParts.length === 0 && dumpItems > 0) machineryDumpRows += 1;
  });
  return {
    messages: rows,
    toolCallCount: toolIds.size,
    rejectedEvents: rejected,
    machineryDumpRows,
    hasEvents: records.length > 0,
  };
};

// ---------------------------------------------------------------------------
// SQLite plumbing (opencode, hermes) — read a snapshot copy, never the live
// db, so no lock can stall the owning agent.
// ---------------------------------------------------------------------------

export interface DbFingerprint {
  readonly size: number;
  readonly mtimeMs: number;
  readonly walSize: number;
  readonly walMtimeMs: number;
}

export const dbFingerprint = (dbPath: string): DbFingerprint => {
  const stat = statSync(dbPath);
  let walSize = 0;
  let walMtimeMs = 0;
  const walPath = `${dbPath}-wal`;
  if (existsSync(walPath)) {
    const walStat = statSync(walPath);
    walSize = walStat.size;
    walMtimeMs = walStat.mtimeMs;
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, walSize, walMtimeMs };
};

export const sameDbFingerprint = (left: DbFingerprint, right: DbFingerprint): boolean =>
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.walSize === right.walSize &&
  left.walMtimeMs === right.walMtimeMs;

export const withDbCopy = <T>(dbPath: string, fn: (db: Database) => T): T => {
  const tempDir = mkdtempSync(join(tmpdir(), "quasar-verify-"));
  const tempDbPath = join(tempDir, basename(dbPath));
  copyFileSync(dbPath, tempDbPath);
  for (const suffix of ["-wal", "-shm"]) {
    const source = `${dbPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, `${tempDbPath}${suffix}`);
  }
  try {
    const db = new Database(tempDbPath, { readonly: true });
    try {
      return fn(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// opencode — opencode-local.db (higher-session-count db wins)
// Documented rules: text parts → messages; plaintext reasoning parts → role
// "reasoning"; tool parts → toolCalls; step-start/step-finish/compaction/file/
// patch parts skipped; the oversized message rows are named diagnostics with
// zero rows. A message-level content string short-circuits part projection.
// ---------------------------------------------------------------------------

const OPENCODE_MACHINERY_PART_TYPES = new Set([
  "step-start",
  "step-finish",
  "compaction",
  "file",
]);

export const opencodeDbPath = (): string | undefined => {
  const root = PROVIDER_ROOTS.opencode();
  const candidates = ["opencode-local.db", "opencode.db"]
    .map((name) => join(root, name))
    .filter((path) => existsSync(path))
    .map((path, index) => {
      const count = withDbCopy(path, (db) => {
        try {
          return (db.query("select count(*) as count from session").get() as { count: number })
            .count;
        } catch {
          return -1;
        }
      });
      return { path, index, count };
    });
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (b.count - a.count === 0 ? a.index - b.index : b.count - a.count));
  return candidates[0]?.path;
};

const opencodeIsToolPart = (part: Record<string, unknown>): boolean => {
  const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
  return type.includes("tool") || part.tool !== undefined || part.toolName !== undefined;
};

const opencodePartText = (part: Record<string, unknown>): string | undefined =>
  typeof part.text === "string"
    ? part.text
    : typeof part.content === "string"
      ? part.content
      : typeof part.message === "string"
        ? part.message
        : undefined;

export const opencodeSessionIds = (db: Database): string[] =>
  (db.query("select id from session order by time_updated desc, id desc").all() as {
    id: string;
  }[]).map((row) => row.id);

export const parseOpencodeSession = (db: Database, nativeSessionId: string): SessionParse => {
  const messages = db
    .query(
      "select id, length(cast(data as blob)) as raw_bytes, data from message where session_id = ? order by time_created, id",
    )
    .all(nativeSessionId) as { id: string; raw_bytes: number; data: string }[];
  const partRows = db
    .query("select message_id, data from part where session_id = ? order by time_created, id")
    .all(nativeSessionId) as { message_id: string; data: string }[];
  const partsByMessage = new Map<string, unknown[]>();
  for (const part of partRows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(part.data);
    } catch {
      parsed = part.data;
    }
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(parsed);
    partsByMessage.set(part.message_id, list);
  }

  const rows: TurnRow[] = [];
  let toolCallCount = 0;
  let rejected = 0;
  let machineryDumpRows = 0;
  messages.forEach((message, seq) => {
    // Boundary rejection on the pre-prune raw row size: zero rows (messages
    // AND toolCalls) for the event, one named diagnostic at ingest.
    if (message.raw_bytes >= CONVEX_MAX_VALUE_BYTES) {
      rejected += 1;
      return;
    }
    let data: Record<string, unknown>;
    try {
      data = asRecord(JSON.parse(message.data));
    } catch {
      data = { content: message.data };
    }
    const parts = (partsByMessage.get(message.id) ?? []).map(asRecord);
    toolCallCount += parts.filter(opencodeIsToolPart).length;

    const role = data.role;
    if (role !== "user" && role !== "assistant") return;
    const contentString =
      stringValue(data.content) ?? stringValue(data.text) ?? stringValue(data.message);
    if (contentString !== undefined) {
      // A message-level content string short-circuits part projection.
      rejected += pushRows(
        rows,
        seq,
        role,
        [],
        contentString.trim().length > 0 ? [contentString] : [],
      );
      return;
    }
    const reasoningParts: string[] = [];
    const textParts: string[] = [];
    let dumpParts = 0;
    for (const part of parts) {
      const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
      if (OPENCODE_MACHINERY_PART_TYPES.has(type)) continue;
      if (type.includes("diff") || type.includes("patch")) continue;
      if (opencodeIsToolPart(part)) continue; // tool payloads never reach search
      const text = opencodePartText(part);
      if (text === undefined || text.trim().length === 0) {
        // The current product stores such a part as a JSON envelope dump
        // (e.g. an empty reasoning part as {"type":"reasoning"}).
        dumpParts += 1;
        continue;
      }
      if (type === "reasoning") reasoningParts.push(text);
      else textParts.push(text);
    }
    rejected += pushRows(rows, seq, role, reasoningParts, textParts);
    if (textParts.length === 0 && dumpParts > 0) machineryDumpRows += 1;
  });
  return { messages: rows, toolCallCount, rejectedEvents: rejected, machineryDumpRows };
};

// ---------------------------------------------------------------------------
// hermes — ~/.hermes/state.db sessions + messages tables (FTS tables ignored)
// content → text rows; reasoning_content/reasoning → role "reasoning" rows;
// structured reasoning_details / codex_* fields project to JSON text blocks;
// tool_calls arrays + tool_call_id results → toolCalls keyed by native id.
// ---------------------------------------------------------------------------

export const hermesDbPath = (): string => join(PROVIDER_ROOTS.hermes(), "state.db");

export const hermesDbPaths = (): readonly string[] => {
  const root = PROVIDER_ROOTS.hermes();
  const paths: string[] = [];
  const profilesDir = join(root, "profiles");
  if (existsSync(profilesDir)) {
    let profileDirs: string[] = [];
    try {
      profileDirs = readdirSync(profilesDir)
        .filter((entry) => {
          try {
            return statSync(join(profilesDir, entry)).isDirectory();
          } catch {
            return false;
          }
        })
        .sort();
    } catch {
      profileDirs = [];
    }
    for (const profileName of profileDirs) {
      const dbPath = join(profilesDir, profileName, "state.db");
      if (existsSync(dbPath)) paths.push(dbPath);
    }
  }
  const topLevelDb = hermesDbPath();
  if (existsSync(topLevelDb)) paths.push(topLevelDb);
  return paths;
};

/** Mirrors the documented machinery-key drop + emptiness pruning so a parsed
 * JSON field's "does it project to anything" answer matches the product. */
const DROPPED_NATIVE_KEYS = new Set([
  "diff",
  "diffs",
  "patch",
  "patches",
  "snapshot",
  "snapshots",
  "fullDiff",
  "fileDiff",
  "displayDiff",
  "displayPatch",
  "uiState",
  "viewState",
  "providerUi",
  "provider_ui",
  "displayOnly",
  "display_only",
  "cache",
  "cached",
  "state",
  "raw",
  "rawContent",
  "encrypted_content",
  "encryptedContent",
  "ciphertext",
  "cipherText",
]);
const SENSITIVE_KEY =
  /(authorization|password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|cookie|credential|private[_-]?key|encrypted[_-]?content|cipher[_-]?text)/i;

const shouldDropKey = (key: string) =>
  DROPPED_NATIVE_KEYS.has(key) ||
  /(?:^|_)(diff|patch|snapshot|ciphertext)(?:$|_)/i.test(key) ||
  /encrypted[_-]?content/i.test(key);

/** Detects machinery-only envelopes: objects that have only a `type` field
 * or no fields at all. These should not appear on the search surface as JSON dumps. */
const isMachineryOnlyEnvelope = (projected: unknown): boolean => {
  if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
    return false;
  }
  const record = projected as Record<string, unknown>;
  const keys = Object.keys(record);
  // Only a type field (or no fields at all) = machinery envelope with no content
  return keys.length <= 1 && (keys.length === 0 || keys[0] === "type");
};

export const projectLite = (value: unknown): unknown => {
  if (value === undefined || value === null) return value === null ? null : undefined;
  if (typeof value === "string") {
    const text = collapse(value);
    return text.length === 0 ? undefined : text;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .map((item) => projectLite(item))
      .filter((item) => item !== undefined);
    return items.length === 0 ? undefined : items;
  }
  if (typeof value !== "object") return undefined;
  const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    if (shouldDropKey(key)) return [];
    const projected = SENSITIVE_KEY.test(key) ? "[redacted]" : projectLite(item);
    return projected === undefined ? [] : [[key, projected] as const];
  });
  if (entries.length === 0) return undefined;
  const result = Object.fromEntries(entries);
  // Machinery-only envelopes (e.g. {type:"reasoning"}) should not surface
  // as JSON dumps on the search surface.
  return isMachineryOnlyEnvelope(result) ? undefined : result;
};

const parseJsonish = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

/** Structured hermes reasoning fields surface as labelled JSON blocks
 * ({type:"json", value, label}) whose compact rendering is a JSON dump. */
const hermesJsonDump = (value: unknown, label: string): string | undefined => {
  const parsed = parseJsonish(value);
  if (parsed === undefined || parsed === null || parsed === "") return undefined;
  const projected = projectLite(parsed);
  if (projected === undefined) return undefined;
  const dump = collapse(JSON.stringify({ type: "json", value: projected, label }) ?? "");
  return dump.length === 0 ? undefined : dump;
};

export const hermesSessionIds = (db: Database): string[] =>
  (db.query("select id from sessions order by started_at desc, id desc").all() as {
    id: unknown;
  }[]).map((row) => String(row.id ?? ""));

export const parseHermesSession = (db: Database, nativeSessionId: string): SessionParse => {
  const messages = db
    .query(
      "select id, role, content, tool_call_id, tool_calls, reasoning, reasoning_content, reasoning_details, codex_reasoning_items, codex_message_items from messages where session_id = ? order by timestamp, id",
    )
    .all(nativeSessionId) as Record<string, unknown>[];
  const rows: TurnRow[] = [];
  const toolIds = new Set<string>();
  let rejected = 0;
  messages.forEach((message, seq) => {
    const nativeEventId = String(message.id ?? seq);
    const callsValue = parseJsonish(message.tool_calls);
    const calls = (Array.isArray(callsValue) ? callsValue : [callsValue])
      .map(asRecord)
      .filter((call) => Object.keys(call).length > 0);
    calls.forEach((call, callIndex) => {
      const nativeToolId =
        stringValue(call.id) ??
        stringValue(call.call_id) ??
        stringValue(call.tool_call_id) ??
        stringValue(call.toolCallId) ??
        `${nativeEventId}:${callIndex}`;
      toolIds.add(nativeToolId);
    });
    const resultToolId = stringValue(message.tool_call_id);
    if (resultToolId !== undefined) toolIds.add(resultToolId);

    const role = message.role;
    if (role !== "user" && role !== "assistant") return;
    const reasoningParts: string[] = [];
    const thinking =
      stringValue(message.reasoning_content) ?? stringValue(message.reasoning);
    if (thinking !== undefined && thinking.trim().length > 0) reasoningParts.push(thinking);
    const textParts: string[] = [];
    const content = stringValue(message.content);
    if (content !== undefined && content.trim().length > 0) textParts.push(content);
    for (const [field, label] of [
      [message.reasoning_details, "reasoning_details"],
      [message.codex_reasoning_items, "codex_reasoning_items"],
      [message.codex_message_items, "codex_message_items"],
    ] as const) {
      const dump = hermesJsonDump(field, label);
      if (dump !== undefined) textParts.push(dump);
    }
    rejected += pushRows(rows, seq, role, reasoningParts, textParts);
  });
  return { messages: rows, toolCallCount: toolIds.size, rejectedEvents: rejected, machineryDumpRows: 0 };
};

// ---------------------------------------------------------------------------
// grok — ~/.grok/sessions/*/chat_history.jsonl (+ events/updates for tool
// machinery). chat/summary/events/updates are read; hunk_records are diff
// machinery and skipped. Assistant `reasoning.text` → role "reasoning" rows;
// tool_calls arrays are the structural surface.
// ---------------------------------------------------------------------------

export const grokSessionDirs = (): string[] =>
  collectFiles(PROVIDER_ROOTS.grok(), (path) => path.endsWith("chat_history.jsonl")).map(
    (path) => dirname(path),
  );

const grokToolName = (record: Record<string, unknown>): string | undefined => {
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  if (typeof record.name === "string" && record.type === undefined) return record.name;
  if (typeof record.name === "string" && String(record.type ?? "").includes("tool")) {
    return record.name;
  }
  const state = asRecord(record.state);
  if (typeof state.tool === "string") return state.tool;
  const params = asRecord(record.params);
  if (typeof params.tool === "string") return params.tool;
  return undefined;
};

const grokStringContent = (record: Record<string, unknown>): string | undefined =>
  typeof record.content === "string"
    ? record.content
    : typeof record.text === "string"
      ? record.text
      : typeof record.message === "string"
        ? record.message
        : undefined;

/**
 * Text extraction for structured (non-string) grok content: arrays of blocks
 * like [{type:"text", text}, …]. Mirrors the documented block grammar — text
 * blocks → text parts, thinking blocks → reasoning parts, tool-context blocks
 * are machinery and never reach the search surface.
 */
const grokExtractParts = (
  value: unknown,
  texts: string[],
  reasonings: string[],
  inToolContext: boolean,
): void => {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    const text = collapse(value);
    if (text.length > 0 && !inToolContext) texts.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) grokExtractParts(item, texts, reasonings, inToolContext);
    return;
  }
  if (typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : undefined;
  const toolContext = inToolContext || (type !== undefined && type.includes("tool"));
  const text =
    stringValue(record.text) ??
    stringValue(record.content) ??
    stringValue(record.message) ??
    stringValue(record.thinking) ??
    stringValue(record.markdown);
  if (text !== undefined) {
    if (text.trim().length === 0) return;
    if (type === "thinking" || record.thinking !== undefined) reasonings.push(text);
    else if (!toolContext) texts.push(text);
    return;
  }
  if (record.content !== undefined) grokExtractParts(record.content, texts, reasonings, toolContext);
  if (record.parts !== undefined) grokExtractParts(record.parts, texts, reasonings, toolContext);
  if (record.message !== undefined) grokExtractParts(record.message, texts, reasonings, toolContext);
};

/** Text/reasoning parts of one grok chat record's content. A plain-string
 * content rides the compact-text path, which only emits for kind "message" —
 * i.e. never on a record that carries tool calls. Structured content builds
 * blocks, which emit regardless of the record's kind. */
const grokRecordParts = (
  record: Record<string, unknown>,
  hasToolCall: boolean,
): { texts: string[]; reasonings: string[] } => {
  const texts: string[] = [];
  const reasonings: string[] = [];
  const direct = grokStringContent(record);
  if (direct !== undefined) {
    if (!hasToolCall) {
      const text = collapse(direct);
      if (text.length > 0) texts.push(text);
    }
    return { texts, reasonings };
  }
  // The block builder only descends into content/message containers.
  for (const key of ["content", "message"]) {
    if (record[key] !== undefined) {
      grokExtractParts(record[key], texts, reasonings, false);
    }
  }
  return { texts, reasonings };
};

const grokReasoningText = (record: Record<string, unknown>): string | undefined => {
  const reasoning = record.reasoning;
  if (reasoning === undefined || reasoning === null) return undefined;
  const reasoningRecord =
    typeof reasoning === "string" ? asRecord(parseJsonish(reasoning)) : asRecord(reasoning);
  return stringValue(reasoningRecord.text);
};

const grokNativeToolId = (record: Record<string, unknown>, fallback: string): string =>
  typeof record.callID === "string"
    ? record.callID
    : typeof record.call_id === "string"
      ? record.call_id
      : typeof record.toolCallId === "string"
        ? record.toolCallId
        : typeof record.id === "string"
          ? record.id
          : fallback;

export const parseGrokSession = (sessionDir: string): SessionParse => {
  const chatLines = readJsonLines(join(sessionDir, "chat_history.jsonl"));
  const eventLines = readJsonLines(join(sessionDir, "events.jsonl"));
  const updateLines = readJsonLines(join(sessionDir, "updates.jsonl"));
  const rows: TurnRow[] = [];
  // The structural surface keeps assistant tool_calls entries under their raw
  // native id and standalone tool records under a per-file scoped id — two
  // distinct key spaces, mirrored here so counts match.
  const toolKeys = new Set<string>();
  let rejected = 0;

  chatLines.forEach((value, seq) => {
    const record = asRecord(value);
    const type = typeof record.type === "string" ? record.type : "message";
    if (type === "assistant") {
      const reasoningText = grokReasoningText(record);
      if (reasoningText !== undefined && reasoningText.trim().length > 0) {
        rows.push({ seq, role: "reasoning", text: reasoningText });
      }
      let hasToolCall = false;
      const callsValue = parseJsonish(record.tool_calls);
      if (Array.isArray(callsValue)) {
        calls: for (const call of callsValue) {
          const callRecord = asRecord(call);
          if (grokToolName(callRecord) === undefined) continue calls;
          toolKeys.add(`raw:${stringValue(callRecord.id) ?? `event:${seq}`}`);
          hasToolCall = true;
        }
      }
      if (!hasToolCall && grokToolName(record) !== undefined) {
        toolKeys.add(`chat:${grokNativeToolId(record, `event:${seq}`)}`);
        hasToolCall = true;
      }
      const { texts, reasonings } = grokRecordParts(record, hasToolCall);
      rejected += pushRows(rows, seq, "assistant", reasonings, texts);
    } else if (type === "tool_result") {
      const resultId = stringValue(record.tool_call_id);
      if (resultId !== undefined) toolKeys.add(`raw:${resultId}`);
      else if (grokToolName(record) !== undefined) {
        toolKeys.add(`chat:${grokNativeToolId(record, `event:${seq}`)}`);
      }
    } else if (type === "user") {
      let hasToolCall = false;
      if (grokToolName(record) !== undefined) {
        toolKeys.add(`chat:${grokNativeToolId(record, `event:${seq}`)}`);
        hasToolCall = true;
      }
      const { texts, reasonings } = grokRecordParts(record, hasToolCall);
      rejected += pushRows(rows, seq, "user", reasonings, texts);
    } else if (grokToolName(record) !== undefined) {
      toolKeys.add(`chat:${grokNativeToolId(record, `event:${seq}`)}`);
    }
  });

  eventLines.forEach((value, index) => {
    const record = asRecord(value);
    if (grokToolName(record) !== undefined) {
      toolKeys.add(`events:${grokNativeToolId(record, `event:${index}`)}`);
    }
  });
  updateLines.forEach((value, index) => {
    const record = asRecord(value);
    if (grokToolName(record) !== undefined) {
      toolKeys.add(`updates:${grokNativeToolId(record, `event:${index}`)}`);
    }
  });

  return { messages: rows, toolCallCount: toolKeys.size, rejectedEvents: rejected, machineryDumpRows: 0 };
};

// ---------------------------------------------------------------------------
// antigravity — ~/.gemini/antigravity-cli/brain/<uuid>/...
// Documented rules: USER_INPUT and the turn-terminal PLANNER_RESPONSE are the
// only searchable messages. Mid-loop planner tool narration, tool execution
// records, reasoning, system rows, and replay markers stay structural.
// ---------------------------------------------------------------------------

const ANTIGRAVITY_TOOL_EXECUTION_TYPES = new Set([
  "VIEW_FILE",
  "LIST_DIRECTORY",
  "GENERIC",
  "CODE_ACTION",
  "RUN_COMMAND",
]);

type AntigravityClassification =
  | { readonly role: "user" | "assistant" | "thinking" | "system" | "unknown"; readonly kind: string }
  | "SKIP";

const antigravityTerminalPlannerIndices = (
  records: readonly { readonly type: string }[],
): ReadonlySet<number> => {
  const terminal = new Set<number>();
  let lastPlannerInTurn: number | undefined;
  const flush = () => {
    if (lastPlannerInTurn !== undefined) terminal.add(lastPlannerInTurn);
    lastPlannerInTurn = undefined;
  };
  for (let i = 0; i < records.length; i += 1) {
    const type = records[i]!.type;
    if (type === "USER_INPUT") {
      flush();
      continue;
    }
    if (type === "PLANNER_RESPONSE") lastPlannerInTurn = i;
  }
  flush();
  return terminal;
};

const classifyAntigravityRecord = (input: {
  readonly type: string;
  readonly hasToolCalls: boolean;
  readonly hasThinking: boolean;
  readonly isTerminalPlannerResponse: boolean;
}): AntigravityClassification => {
  const { type, hasToolCalls, hasThinking, isTerminalPlannerResponse } = input;
  if (type === "CONVERSATION_HISTORY") return "SKIP";
  if (type === "USER_INPUT") return { role: "user", kind: "message" };
  if (type === "PLANNER_RESPONSE") {
    if (isTerminalPlannerResponse) return { role: "assistant", kind: "message" };
    if (hasToolCalls) return { role: "assistant", kind: "tool_call" };
    if (hasThinking) return { role: "thinking", kind: "reasoning" };
    return { role: "unknown", kind: "lifecycle" };
  }
  if (ANTIGRAVITY_TOOL_EXECUTION_TYPES.has(type)) return { role: "assistant", kind: "tool_call" };
  if (type === "CHECKPOINT" || type === "SYSTEM_MESSAGE") return { role: "system", kind: "system" };
  return { role: "unknown", kind: "unknown" };
};

export const antigravitySessionDirs = (): string[] => {
  const root = PROVIDER_ROOTS.antigravity();
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((entry) => join(root, entry))
    .filter((path) => {
      try {
        return (
          statSync(path).isDirectory() &&
          existsSync(join(path, ".system_generated", "logs", "transcript_full.jsonl"))
        );
      } catch {
        return false;
      }
    });
};

export const parseAntigravitySession = (sessionDir: string): SessionParse => {
  const transcriptPath = join(sessionDir, ".system_generated", "logs", "transcript_full.jsonl");
  const parsed = readJsonLines(transcriptPath).map((value) => {
    const record = asRecord(value);
    return {
      record,
      type: typeof record.type === "string" ? record.type : "unknown",
    };
  });
  const terminalIndices = antigravityTerminalPlannerIndices(parsed);
  const rows: TurnRow[] = [];
  const toolKeys = new Set<string>();
  let rejected = 0;
  let seq = 0;

  parsed.forEach(({ record, type }, recordIndex) => {
    const rawToolCalls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    const hasThinking = typeof record.thinking === "string" && record.thinking.length > 0;
    const classification = classifyAntigravityRecord({
      type,
      hasToolCalls: rawToolCalls.length > 0,
      hasThinking,
      isTerminalPlannerResponse: terminalIndices.has(recordIndex),
    });
    if (classification === "SKIP") return;

    const stepIndex = typeof record.step_index === "number" ? record.step_index : seq;
    for (const callValue of rawToolCalls) {
      const call = asRecord(callValue);
      const toolName = stringValue(call.name);
      if (toolName !== undefined) toolKeys.add(`${stepIndex}:${toolName}`);
    }

    if (
      classification.kind === "message" &&
      (classification.role === "user" || classification.role === "assistant")
    ) {
      const text = typeof record.content === "string" ? collapse(record.content) : "";
      rejected += pushRows(
        rows,
        seq,
        classification.role,
        [],
        text.length > 0 ? [text] : [],
      );
    }
    seq += 1;
  });

  return { messages: rows, toolCallCount: toolKeys.size, rejectedEvents: rejected, machineryDumpRows: 0 };
};

// ---------------------------------------------------------------------------
// Provider totals
// ---------------------------------------------------------------------------

const sumParses = (parses: readonly SessionParse[]): ProviderTotals => ({
  sessions: parses.length,
  messages: parses.reduce((sum, parse) => sum + parse.messages.length, 0),
  toolCalls: parses.reduce((sum, parse) => sum + parse.toolCallCount, 0),
  rejectedEvents: parses.reduce((sum, parse) => sum + parse.rejectedEvents, 0),
  machineryDumpRows: parses.reduce((sum, parse) => sum + parse.machineryDumpRows, 0),
});

export const claudeTotals = (): ProviderTotals =>
  sumParses(claudeSessionFiles().map(parseClaudeSession));

export const codexTotals = (): ProviderTotals => {
  // A rollout file with zero parseable records yields no session.
  const parses = codexSessionFiles()
    .map(parseCodexSession)
    .filter((parse) => parse.hasEvents);
  return sumParses(parses);
};

export const opencodeTotals = (): ProviderTotals | undefined => {
  const dbPath = opencodeDbPath();
  if (dbPath === undefined) return undefined;
  return withDbCopy(dbPath, (db) =>
    sumParses(opencodeSessionIds(db).map((id) => parseOpencodeSession(db, id))),
  );
};

export const hermesTotals = (): ProviderTotals | undefined => {
  const dbPaths = hermesDbPaths();
  if (dbPaths.length === 0) return undefined;
  const parses = dbPaths.flatMap((dbPath) =>
    withDbCopy(dbPath, (db) =>
      hermesSessionIds(db).map((id) => parseHermesSession(db, id)),
    ),
  );
  return sumParses(parses);
};

export const grokTotals = (): ProviderTotals =>
  sumParses(grokSessionDirs().map(parseGrokSession));

export const antigravityTotals = (): ProviderTotals =>
  sumParses(antigravitySessionDirs().map(parseAntigravitySession));

// ---------------------------------------------------------------------------
// Session-identity plumbing for fidelity sampling: recompute the stored
// sessionId (`provider:machineId:wideHash(nativeSessionId:sourcePath)`) so a
// Convex session row can be matched back to its SQLite-native session.
// ---------------------------------------------------------------------------

const fnvHash = (value: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const wideHash = (value: string): string =>
  [fnvHash(`a:${value}`), fnvHash(`b:${value}`), fnvHash(`c:${value}`), fnvHash(`d:${value}`)].join(
    "",
  );

export const loadMachineId = (): string => {
  const quasarHome =
    process.env.QUASAR_HOME ?? join(home(), ".config", "quasar");
  const machine = JSON.parse(readFileSync(join(quasarHome, "machine.json"), "utf8")) as {
    machineId: string;
  };
  return machine.machineId;
};

export const expectedSessionId = (
  provider: string,
  machineId: string,
  nativeSessionId: string,
  sourcePath: string,
): string => `${provider}:${machineId}:${wideHash(`${nativeSessionId}:${sourcePath}`)}`;
