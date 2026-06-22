import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { KimiSessionId } from "../core/identity";
import type { SessionEdge, ToolCall, UsageRecord } from "../core/schemas";
import {
  buildSession,
  compactText,
  edgeIdFor,
  eventIdFor,
  homePath,
  projectToolPayloadNativeValue,
  recordFrom,
  readJsonFile,
  readJsonLines,
  scopedId,
  sessionIdFor,
  sourceFingerprintFor,
  sourceRoot,
  stringValue,
  usageIdFor,
  type NativeValue,
} from "./common";
import { type DecodeDiagnostic, decodeOrDrop, isSignal } from "./harness-schema";
import {
  classifyKimiRecord,
  KimiWireRecordSchema,
  type KimiAppendLoopEventRecord,
  type KimiAppendMessageRecord,
  type KimiUsageRecordType,
  type KimiWireRecord,
} from "./kimi-schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type KimiToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type KimiEventDraft = {
  readonly id: string;
  readonly nativeEventId?: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly role: "user" | "assistant" | "system" | "thinking" | "unknown";
  readonly kind:
    | "message"
    | "preamble"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "summary"
    | "lifecycle"
    | "unknown";
  readonly contentText?: string;
  readonly contentSource?: NativeValue;
  readonly toolCallId?: string;
  readonly rawReference: {
    readonly sourcePath: string;
    readonly line: number;
    readonly nativeType: string;
    readonly agentId?: string;
  };
};

type KimiUsageDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type KimiEdgeDraft = Omit<
  SessionEdge,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];

/**
 * One agent inside a Kimi session directory, as declared in state.json's
 * `agents` dict. The `id` is the dict key (`main`, `agent-0`, ...); `type` is
 * `main` for the root agent and `sub` for spawned sub-agents; `parentAgentId`
 * names the spawning agent (`main` for subs, null/absent for the root).
 */
type KimiAgent = {
  readonly id: string;
  readonly type: string | undefined;
  readonly parentAgentId: string | undefined;
  readonly wirePath: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert epoch-ms (number) or ISO string to ISO string. */
const kimiTime = (time: unknown): string | undefined => {
  if (typeof time === "number" && Number.isFinite(time)) {
    return new Date(time).toISOString();
  }
  if (typeof time === "string" && time.length > 0) return time;
  return undefined;
};

/**
 * Concatenate the `text` parts of a decoded append_message into a single
 * transcript string. The schema validated `content` as an array of unknown
 * parts; we project only the string `text` fields (the only content shape the
 * real corpus carries) and return undefined when there is none.
 */
const messageContentText = (msg: KimiAppendMessageRecord): string | undefined => {
  const content = msg.message.content ?? [];
  const textParts = content
    .map((c) => recordFrom(c))
    .flatMap((c) => (typeof c.text === "string" ? [c.text] : []));
  return textParts.length > 0 ? textParts.join(" ") : undefined;
};

/**
 * The session-level agentName for a Kimi agent. The root agent reports as the
 * harness itself (`kimi-code`); a sub-agent reports its declared type so the
 * served SessionRow.agentName distinguishes a first-class sub-agent session
 * from its parent. The agent id is appended so two subs are never collapsed.
 */
const agentNameFor = (agent: KimiAgent): string =>
  agent.type === "main" || agent.id === "main"
    ? "kimi-code"
    : `kimi-${agent.type ?? "sub"}:${agent.id}`;

/**
 * Enumerate every agent that has a readable agents/<id>/wire.jsonl.
 *
 * The state.json `agents` dict is the primary source of truth for which agents
 * exist and their lineage (type + parentAgentId). Each agent reads its OWN
 * agents/<id>/wire.jsonl. An agent declared without a wire file on disk is
 * skipped (no events to project).
 *
 * BOUNDARY (AGENTS.md): a wire dir present ON DISK but ABSENT from
 * state.json.agents is a provider surprise. It is never silently dropped — that
 * would lose transcript content. Instead it emits a NAMED diagnostic
 * (`kimi.agent.undeclared_wire`, carrying session id + agent id) AND is ingested
 * as its own first-class orphan session: attributed to `main` so its content is
 * recoverable rather than vanishing.
 */
const collectAgents = (
  sessionDir: string,
  nativeSessionId: string,
  state: Record<string, unknown>,
  diagnostics: DecodeDiagnostic[],
): KimiAgent[] => {
  const agentsRecord = recordFrom(state.agents);
  const agents: KimiAgent[] = [];
  const declared = new Set<string>();
  for (const id of Object.keys(agentsRecord).sort()) {
    const meta = recordFrom(agentsRecord[id]);
    const wirePath = join(sessionDir, "agents", id, "wire.jsonl");
    if (!existsSync(wirePath)) continue;
    declared.add(id);
    agents.push({
      id,
      type: stringValue(meta.type),
      parentAgentId: stringValue(meta.parentAgentId),
      wirePath,
    });
  }

  // Scan the agents/ directory on disk for wire.jsonl files NOT declared in
  // state.json.agents. Each such orphan is named + ingested, never dropped.
  const agentsDir = join(sessionDir, "agents");
  if (existsSync(agentsDir)) {
    let entries: string[];
    try {
      entries = readdirSync(agentsDir).sort();
    } catch {
      entries = [];
    }
    for (const id of entries) {
      if (declared.has(id)) continue;
      const wirePath = join(agentsDir, id, "wire.jsonl");
      if (!existsSync(wirePath)) continue;
      diagnostics.push({
        name: "kimi.agent.undeclared_wire",
        message: `session=${nativeSessionId} agent=${id}: agents/${id}/wire.jsonl present on disk but absent from state.json.agents; ingested as orphan attributed to main`,
      });
      agents.push({
        id,
        // No declared lineage — treat as a sub attributed to main so content is
        // never lost.
        type: "sub",
        parentAgentId: "main",
        wirePath,
      });
    }
  }

  return agents;
};

// ---------------------------------------------------------------------------
// Event building for a single agent wire.jsonl
// ---------------------------------------------------------------------------

type AgentLineEvent = {
  readonly lineNumber: number;
  readonly outerTime: number;
  /** The decoded, schema-validated wire record (the typed discriminated union). */
  readonly record: KimiWireRecord;
};

/**
 * Parse a single agent's wire.jsonl into typed line-events, fail-closed.
 *
 * Every line is decoded through the shared `decodeOrDrop` boundary against the
 * FULL `KimiWireRecordSchema` discriminated union (QSR-220): an unmodeled outer
 * type, a malformed record (not an object, non-string/unknown `type`, wrong
 * inner shape) becomes a NAMED diagnostic (`kimi.wire.decode_failed`) in
 * `diagnostics` and is dropped — it never throws (the rest of the wire keeps
 * importing) and never silently coerces a half-record. There is NO unknown
 * pass-through: a line that does not match one of the modeled record types is
 * rejected here, not carried forward as an ad-hoc untyped record. Lines that
 * fail JSON parse are already dropped by `readJsonLines` upstream.
 */
const collectAgentLineEvents = (
  agent: KimiAgent,
  diagnostics: DecodeDiagnostic[],
): AgentLineEvent[] => {
  let lines: { value: unknown; lineNumber: number }[];
  try {
    lines = readJsonLines(agent.wirePath);
  } catch {
    return [];
  }
  const result: AgentLineEvent[] = [];
  for (const { value, lineNumber } of lines) {
    const decision = decodeOrDrop(KimiWireRecordSchema, value, {
      kind: "wire" as const,
      diagnosticName: "kimi.wire.decode_failed",
      diagnostics,
    });
    if (!isSignal(decision)) continue;
    const record = decision.value;
    // `metadata` is the one bootstrap record with no `time`; every other arm
    // carries the optional epoch-ms ordering key.
    const recordTime = "time" in record ? record.time : undefined;
    const outerTime =
      typeof recordTime === "number" && Number.isFinite(recordTime) ? recordTime : 0;
    result.push({ lineNumber, outerTime, record });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Per-agent session builder
// ---------------------------------------------------------------------------

const buildAgentSession = (
  params: {
    readonly agent: KimiAgent;
    readonly nativeSessionId: string;
    readonly mainSessionId: ReturnType<typeof sessionIdFor>;
    readonly sessionDir: string;
    readonly workDir: string;
    readonly title: string | undefined;
    readonly createdAt: string | undefined;
    readonly updatedAt: string | undefined;
    readonly sessionsRoot: string;
  },
  options: AdapterOptions,
  diagnostics: DecodeDiagnostic[],
) => {
  const { agent } = params;
  const isMain = agent.type === "main" || agent.id === "main";
  // (1) main → keyed by the unchanged native session id.
  // (2) each sub-agent → keyed by the COMPOUND native id `${sessionId}/${agentId}`
  //     so every spawned agent becomes its own first-class session.
  const nativeId = isMain
    ? KimiSessionId(params.nativeSessionId)
    : KimiSessionId(`${params.nativeSessionId}/${agent.id}`);
  const sessionId = sessionIdFor("kimi", nativeId);

  const lineEvents = collectAgentLineEvents(agent, diagnostics);
  lineEvents.sort((a, b) => {
    if (a.outerTime !== b.outerTime) return a.outerTime - b.outerTime;
    return a.lineNumber - b.lineNumber;
  });

  const toolCallsById = new Map<string, KimiToolCallDraft>();
  const usageDrafts: KimiUsageDraft[] = [];
  const eventDrafts: KimiEventDraft[] = [];
  const sessionEdges: KimiEdgeDraft[] = [];

  // Canonical SESSION-to-session subagent lineage. A sub-agent emits a
  // `kind="subagent_of"` edge whose `fromId` is its REAL parent's canonical
  // SessionId and whose `toId` is this sub-agent's own SessionId. This is the
  // purpose-built session-lineage edge — never `parent`, which is event
  // threading. mapSession projects `subagent_of.fromId` onto the served
  // SessionRow.parentSessionId column; the native parent id is kept in
  // rawReference. The main agent emits no such edge (its parentSessionId stays
  // undefined).
  //
  // Parent resolution honours agent.parentAgentId: a sub spawned by `main` (or
  // with no declared parent) links to the main session's canonical id; a sub
  // spawned by ANOTHER sub links to that sub's own compound canonical id, so
  // deep lineage is preserved rather than flattening every sub onto main.
  if (!isMain) {
    const parentAgentId = agent.parentAgentId ?? "main";
    const fromId =
      parentAgentId === "main"
        ? params.mainSessionId
        : sessionIdFor("kimi", KimiSessionId(`${params.nativeSessionId}/${parentAgentId}`));
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", fromId, sessionId),
      kind: "subagent_of",
      fromId,
      toId: sessionId,
      rawReference: {
        sourcePath: agent.wirePath,
        nativeType: "agent",
        agentId: agent.id,
        parentAgentId,
      },
    });
  }

  for (let seq = 0; seq < lineEvents.length; seq++) {
    const { lineNumber, outerTime, record } = lineEvents[seq]!;
    const agentId = agent.id;
    const wirePath = agent.wirePath;
    const outerType = record.type;
    const outerTimeIso = kimiTime(outerTime !== 0 ? outerTime : undefined);

    const eventId = eventIdFor(sessionId, seq, `${agentId}:${lineNumber}`);

    // DECLARATIVE per-record-type dispatch (QSR-220). The decoded record is one
    // of the modeled discriminated-union arms; `classifyKimiRecord` returns the
    // single authoritative signal(kind)/drop(reason) verdict. There is no
    // kind/role heuristic here any more and no unknown fall-through: a record
    // that reached this point is already schema-valid, and a record type that is
    // a DROP is explicitly discarded under its named reason (it never becomes an
    // invented "unknown" event).
    const verdict = classifyKimiRecord(record);
    if (verdict._tag === "drop") {
      // Lifecycle / accounting noise: not transcript signal. Dropped by name,
      // not coerced into an event. (Diagnostics for these are intentionally
      // silent — they are EXPECTED records, not malformed ones; only decode
      // failures earn a `kimi.wire.decode_failed` diagnostic upstream.)
      continue;
    }

    switch (verdict.kind) {
      case "message.user": {
        const msg = record as KimiAppendMessageRecord;
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "user",
          kind: "message",
          contentText: messageContentText(msg),
          contentSource: messageContentText(msg),
          rawReference: { sourcePath: wirePath, line: lineNumber, nativeType: outerType, agentId },
        });
        break;
      }
      case "message.preamble": {
        const msg = record as KimiAppendMessageRecord;
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "system",
          kind: "preamble",
          contentText: messageContentText(msg),
          contentSource: messageContentText(msg),
          rawReference: { sourcePath: wirePath, line: lineNumber, nativeType: outerType, agentId },
        });
        break;
      }
      case "assistant.text": {
        const loop = record as KimiAppendLoopEventRecord;
        const part = loop.event.type === "content.part" ? loop.event.part : undefined;
        const text = part?.text;
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "assistant",
          kind: "message",
          contentText: text,
          contentSource: text,
          rawReference: {
            sourcePath: wirePath,
            line: lineNumber,
            nativeType: "content.part:text",
            agentId,
          },
        });
        break;
      }
      case "assistant.think": {
        const loop = record as KimiAppendLoopEventRecord;
        const part = loop.event.type === "content.part" ? loop.event.part : undefined;
        const think = part?.think;
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "thinking",
          kind: "reasoning",
          contentText: think,
          contentSource: think,
          rawReference: {
            sourcePath: wirePath,
            line: lineNumber,
            nativeType: "content.part:think",
            agentId,
          },
        });
        break;
      }
      case "tool.call": {
        const loop = record as KimiAppendLoopEventRecord;
        const ev = loop.event.type === "tool.call" ? loop.event : undefined;
        const toolCallId = ev?.toolCallId;
        const toolName = ev?.name ?? "kimi_tool";
        const input = projectToolPayloadNativeValue(ev?.args);
        const draft: KimiToolCallDraft = {
          id: scopedId(sessionId, "tool", toolCallId ?? eventId),
          eventId,
          toolName,
          status: "started",
          ...(input !== undefined ? { input } : {}),
          ...(outerTimeIso !== undefined ? { startedAt: outerTimeIso } : {}),
        };
        if (toolCallId !== undefined) toolCallsById.set(toolCallId, draft);
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "assistant",
          kind: "tool_call",
          toolCallId: draft.id,
          rawReference: {
            sourcePath: wirePath,
            line: lineNumber,
            nativeType: "tool.call",
            agentId,
          },
        });
        break;
      }
      case "tool.result": {
        const loop = record as KimiAppendLoopEventRecord;
        const ev = loop.event.type === "tool.result" ? loop.event : undefined;
        const toolCallId = ev?.toolCallId;
        const resultRecord = recordFrom(ev?.result);
        const output = projectToolPayloadNativeValue(resultRecord.output ?? ev?.result);
        const contentText =
          typeof resultRecord.output === "string"
            ? compactText(resultRecord.output)
            : undefined;

        if (toolCallId !== undefined) {
          const existing = toolCallsById.get(toolCallId);
          const merged: KimiToolCallDraft = {
            id: existing?.id ?? scopedId(sessionId, "tool", toolCallId),
            eventId: existing?.eventId ?? eventId,
            toolName: existing?.toolName ?? "kimi_tool",
            status: "completed",
            ...(existing?.input !== undefined ? { input: existing.input } : {}),
            ...(output !== undefined ? { output } : {}),
            ...(existing?.startedAt !== undefined ? { startedAt: existing.startedAt } : {}),
            ...(outerTimeIso !== undefined ? { completedAt: outerTimeIso } : {}),
          };
          toolCallsById.set(toolCallId, merged);
          eventDrafts.push({
            id: eventId,
            sequence: seq,
            timestamp: outerTimeIso,
            role: "unknown",
            kind: "tool_result",
            contentText,
            toolCallId: merged.id,
            rawReference: {
              sourcePath: wirePath,
              line: lineNumber,
              nativeType: "tool.result",
              agentId,
            },
          });
        } else {
          const minimalId = scopedId(sessionId, "tool", eventId);
          const minimal: KimiToolCallDraft = {
            id: minimalId,
            eventId,
            toolName: "kimi_tool",
            status: "completed",
            ...(output !== undefined ? { output } : {}),
            ...(outerTimeIso !== undefined ? { completedAt: outerTimeIso } : {}),
          };
          toolCallsById.set(eventId, minimal);
          eventDrafts.push({
            id: eventId,
            sequence: seq,
            timestamp: outerTimeIso,
            role: "unknown",
            kind: "tool_result",
            contentText,
            toolCallId: minimalId,
            rawReference: {
              sourcePath: wirePath,
              line: lineNumber,
              nativeType: "tool.result",
              agentId,
            },
          });
        }
        break;
      }
      case "summary": {
        const summary =
          record.type === "context.apply_compaction" ? record.summary : undefined;
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "assistant",
          kind: "summary",
          contentText: summary,
          contentSource: summary,
          rawReference: {
            sourcePath: wirePath,
            line: lineNumber,
            nativeType: outerType,
            agentId,
          },
        });
        break;
      }
      case "usage": {
        const usageRecord = record as KimiUsageRecordType;
        const model = usageRecord.model;
        const usage = usageRecord.usage;
        const inputOther = usage?.inputOther;
        const output = usage?.output;
        const inputCacheRead = usage?.inputCacheRead;
        const inputCacheCreation = usage?.inputCacheCreation;

        const usageId = usageIdFor(sessionId, undefined, usageDrafts.length);
        usageDrafts.push({
          id: usageId,
          timestamp: outerTimeIso,
          ...(model !== undefined ? { model } : {}),
          ...(inputOther !== undefined ? { inputTokens: inputOther } : {}),
          ...(output !== undefined ? { outputTokens: output } : {}),
          ...(inputCacheRead !== undefined ? { cacheReadInputTokens: inputCacheRead } : {}),
          ...(inputCacheCreation !== undefined
            ? { cacheCreationInputTokens: inputCacheCreation }
            : {}),
        });
        break;
      }
    }
  }

  return buildSession({
    provider: "kimi",
    agentName: agentNameFor(agent),
    machine: options.machine,
    sessionId,
    nativeSessionId: nativeId,
    projectPath: params.workDir.length > 0 ? params.workDir : undefined,
    title: params.title,
    startedAt: params.createdAt,
    updatedAt: params.updatedAt,
    sourceRoot: params.sessionsRoot,
    sourcePath: join(params.sessionDir, "agents", agent.id),
    events: eventDrafts,
    toolCalls: [...toolCallsById.values()],
    sessionEdges,
    usageRecords: usageDrafts,
  });
};

// ---------------------------------------------------------------------------
// Session-entry fan-out: one entry → one session per agent
// ---------------------------------------------------------------------------

const buildKimiSessionsFromEntry = (
  entry: { sessionId: string; sessionDir: string; workDir: string },
  sessionsRoot: string,
  options: AdapterOptions,
  diagnostics: DecodeDiagnostic[],
) => {
  const stateRaw = readJsonFile(join(entry.sessionDir, "state.json"));
  const state = recordFrom(stateRaw);

  const isCustomTitle = state.isCustomTitle === true;
  const title = isCustomTitle ? stringValue(state.title) : undefined;
  const createdAt = stringValue(state.createdAt);
  const updatedAt = stringValue(state.updatedAt);

  const mainSessionId = sessionIdFor("kimi", KimiSessionId(entry.sessionId));
  const agents = collectAgents(entry.sessionDir, entry.sessionId, state, diagnostics);

  return agents.map((agent) =>
    buildAgentSession(
      {
        agent,
        nativeSessionId: entry.sessionId,
        mainSessionId,
        sessionDir: entry.sessionDir,
        workDir: entry.workDir,
        title,
        createdAt,
        updatedAt,
        sessionsRoot,
      },
      options,
      diagnostics,
    ),
  );
};

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

async function* streamKimi(options: AdapterOptions): AsyncGenerator<AdapterStreamItem> {
  const root = options.roots?.kimi ?? kimiAdapter.defaultRoot();
  if (root === undefined || !existsSync(root)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: kimiAdapter.id,
        provider: "kimi",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Kimi Code root was not found.",
        ...(root !== undefined ? { rootPath: root } : {}),
      },
    };
    return;
  }

  const indexPath = join(root, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: kimiAdapter.id,
        provider: "kimi",
        status: "no_data_found",
        parserConfidence: "observed",
        message: "Kimi Code session_index.jsonl not found.",
        rootPath: root,
      },
    };
    return;
  }

  const sessionsRoot = join(root, "sessions");

  const rootRecord = sourceRoot("kimi", kimiAdapter.id, sessionsRoot, options.machine, options.now);
  yield { type: "sourceRoot", sourceRoot: rootRecord };

  const indexLines = readJsonLines(indexPath);
  let sessionCount = 0;
  let skipped = 0;
  const decodeDiagnostics: DecodeDiagnostic[] = [];

  for (const { value } of indexLines) {
    const entry = recordFrom(value);
    const sessionId = stringValue(entry.sessionId);
    const sessionDir = stringValue(entry.sessionDir);
    const workDir = stringValue(entry.workDir) ?? "";

    if (sessionId === undefined || sessionDir === undefined) continue;
    if (!existsSync(sessionDir)) continue;

    if (skipped < (options.skip ?? 0)) { skipped++; continue; }
    if (sessionCount >= (options.limit ?? Number.POSITIVE_INFINITY)) break;

    // Stat-level gate on state.json BEFORE opening it or any wire.jsonl.
    // An unchanged state.json means the whole agent tree is unchanged; skip
    // the entire session entry (main + all sub-agents) without reading anything.
    const stateJsonPath = join(sessionDir, "state.json");
    if (options.shouldReadFile !== undefined && existsSync(stateJsonPath)) {
      const stat = statSync(stateJsonPath);
      if (!options.shouldReadFile(stateJsonPath, stat)) continue;
    }

    // Pre-parse gate keys off the MAIN session id. The whole agent tree shares
    // one state.json fingerprint, so a hit skips the entire entry (main + subs)
    // together — they always change together.
    if (options.shouldParseSession !== undefined) {
      if (existsSync(stateJsonPath)) {
        const stat = statSync(stateJsonPath);
        const probe = {
          sessionId: sessionIdFor("kimi", KimiSessionId(sessionId)),
          sourceFingerprint: sourceFingerprintFor(stat),
        };
        if ((await options.shouldParseSession(probe)) === false) continue;
      }
    }

    const sessions = buildKimiSessionsFromEntry(
      { sessionId, sessionDir, workDir },
      sessionsRoot,
      options,
      decodeDiagnostics,
    );

    for (const session of sessions) {
      yield {
        type: "session",
        session,
        sourceUnit: {
          provider: "kimi",
          adapterId: kimiAdapter.id,
          rootPath: sessionsRoot,
          sourcePath: session.sourcePath,
          physicalPath: existsSync(stateJsonPath) ? stateJsonPath : sessionDir,
        },
      };
      sessionCount += 1;
    }
  }

  // Surface every named wire-decode drop as a single attributable diagnostic.
  for (const diagnostic of decodeDiagnostics) {
    yield {
      type: "diagnostic",
      diagnostic: {
        adapterId: kimiAdapter.id,
        provider: "kimi",
        status: "unsupported",
        parserConfidence: "observed",
        rootPath: sessionsRoot,
        message: `Kimi wire record dropped (${diagnostic.name}).`,
        details: { error: diagnostic.message },
      },
    };
  }

  yield {
    type: "diagnostic",
    diagnostic: {
      adapterId: kimiAdapter.id,
      provider: "kimi",
      status: sessionCount > 0 ? "available" : "no_data_found",
      parserConfidence: "observed",
      rootPath: sessionsRoot,
      message: `Discovered ${sessionCount} Kimi Code session(s).`,
    },
  };
}

// ---------------------------------------------------------------------------
// Adapter export
// ---------------------------------------------------------------------------

export const kimiAdapter: SessionAdapter = {
  id: "kimi-code-session-folder",
  provider: "kimi",
  displayName: "Kimi Code session folder",
  stable: true,
  defaultRoot: () => homePath(".kimi-code"),
  read: async (options) => collectAdapterStream(streamKimi(options)),
  stream: streamKimi,
};
