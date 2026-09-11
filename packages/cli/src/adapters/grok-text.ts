import { parseJsonString, recordFrom, stringValue } from "./common";

/**
 * Grok chat-entry text extraction and provider-machinery classification.
 *
 * The on-disk `chat_history.jsonl` stream, the historical request
 * `chat_history` snapshots, and the checkpoint `compacted_history` snapshots
 * are all arrays of the SAME per-record shapes (user / assistant / reasoning /
 * tool_result / system / backend_tool_call). Both the session projection in
 * `grok.ts` and the archive recovery in `grok-recovery.ts` MUST derive text and
 * machinery identity the same way, so the derivation lives here once.
 */

/**
 * Strip a leading/trailing `<user_query>...</user_query>` or
 * `<user_info>...</user_info>` wrapper if the ENTIRE text is the wrapper.
 * Only removes the wrapper tags; the inner content is kept verbatim.
 * Both wrappers are harness-injected; `<user_info>` carries env/OS context
 * (mutually exclusive with `<user_query>` in any given record).
 */
export const stripUserQueryWrapper = (text: string): string => {
  const trimmed = text.trim();
  for (const [openTag, closeTag] of [
    ["<user_query>", "</user_query>"],
    ["<user_info>", "</user_info>"],
  ] as const) {
    if (trimmed.startsWith(openTag) && trimmed.endsWith(closeTag)) {
      return trimmed.slice(openTag.length, trimmed.length - closeTag.length).trim();
    }
  }
  return text;
};

/**
 * Extract the leaf text from a grok content value.
 * - string: use directly (strip user_query wrapper)
 * - array: join `.text` from items with `.text` field (e.g. [{type:"text",text:"..."}])
 * - object with `.text`: extract the text field (e.g. {type:"text",text:"..."})
 * - other: return undefined (caller handles as NativeValue)
 */
export const extractGrokContentLeaf = (content: unknown): string | undefined => {
  if (typeof content === "string") {
    return stripUserQueryWrapper(content);
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (item === null || typeof item !== "object") continue;
      const itemRecord = item as Record<string, unknown>;
      // Accept {type:"text", text:"..."} or any {text:"..."} block
      if (typeof itemRecord.text === "string") {
        parts.push(itemRecord.text);
      }
    }
    const joined = parts.join("").trim();
    return joined.length > 0 ? stripUserQueryWrapper(joined) : undefined;
  }
  if (content !== null && typeof content === "object") {
    const rec = content as Record<string, unknown>;
    if (typeof rec.text === "string") return stripUserQueryWrapper(rec.text);
  }
  return undefined;
};

/**
 * Peel the known per-harness grok envelope down to the leaf message value.
 *
 * Record shapes:
 *   - chat_history: record.content (string | [{type:"text",text:"..."}])
 *   - updates: record.params.update.content (string | [{text:"..."}])
 *   - fallback: record.text, record.message, record.delta
 *
 * The leaf is returned VERBATIM — no prose-vs-json classification, no
 * reformatting. Agent-generated JSON inside a text block is legitimate
 * searchable content and is preserved as-is.
 */
export const extractGrokProse = (record: Record<string, unknown>): string | undefined => {
  // 1. Direct content field (chat_history user/assistant/tool_result/system)
  if (record.content !== undefined) {
    const leaf = extractGrokContentLeaf(record.content);
    if (leaf !== undefined) return leaf;
  }
  // 2. updates.jsonl: params.update.content
  const params = recordFrom(record.params);
  const update = recordFrom(params?.update);
  if (update?.content !== undefined) {
    const leaf = extractGrokContentLeaf(update.content);
    if (leaf !== undefined) return leaf;
  }
  // 3. Direct text / message / delta fallbacks
  if (typeof record.text === "string") return stripUserQueryWrapper(record.text);
  if (typeof record.message === "string") return stripUserQueryWrapper(record.message);
  if (typeof record.delta === "string") return stripUserQueryWrapper(record.delta);
  return undefined;
};

/**
 * Extract plaintext reasoning text from a STANDALONE `{type:"reasoning"}` record.
 * The dominant shape: `record.summary` is an array of `{type?, text}` items.
 * Fallback: top-level `record.text` field.
 * This is distinct from the EMBEDDED path (record.reasoning inside an assistant
 * record) handled by `grokReasoningText`.
 */
export const grokStandaloneReasoningText = (record: Record<string, unknown>): string | undefined => {
  // Primary: summary[*].text joined
  if (Array.isArray(record.summary)) {
    const parts: string[] = [];
    for (const item of record.summary) {
      if (item !== null && typeof item === "object") {
        const t = (item as Record<string, unknown>).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    const joined = parts.join("").trim();
    if (joined.length > 0) return joined;
  }
  // Fallback: top-level text field
  if (typeof record.text === "string" && record.text.length > 0) return record.text;
  return undefined;
};

/** Extract plaintext reasoning text from an assistant record's `reasoning` field. */
export const grokReasoningText = (record: Record<string, unknown>): string | undefined => {
  const reasoningField = record.reasoning;
  if (reasoningField === undefined || reasoningField === null) return undefined;
  const reasoningRecord =
    typeof reasoningField === "string"
      ? recordFrom(parseJsonString(reasoningField))
      : recordFrom(reasoningField);
  if (reasoningRecord === undefined) return undefined;
  // Try reasoning.summary[*].text first (encrypted reasoning block with plaintext summary)
  if (Array.isArray(reasoningRecord.summary)) {
    const summaryParts: string[] = [];
    for (const item of reasoningRecord.summary) {
      if (item !== null && typeof item === "object") {
        const s = (item as Record<string, unknown>).text;
        if (typeof s === "string") summaryParts.push(s);
      }
    }
    const summaryText = summaryParts.join("").trim();
    if (summaryText.length > 0) return summaryText;
  }
  // Fallback: reasoning.text
  return stringValue(reasoningRecord.text);
};

/**
 * Structural identity of one chat entry, used ONLY for alignment of cumulative
 * archive snapshots (complete structural prefix equality). It intentionally
 * excludes volatile fields (model fingerprint, reasoning_effort, tool ids), so
 * the same authored turn renders the same key across snapshots. Identical turns
 * at DIFFERENT positions stay distinct because alignment is positional.
 */
export const grokEntryStructuralKey = (value: unknown): string => {
  const record = recordFrom(value);
  if (record === undefined) return `raw\u0000${JSON.stringify(value) ?? "null"}`;
  const type = stringValue(record.type) ?? "?";
  const parts: string[] = [];
  if (type === "reasoning") {
    const reasoning = grokStandaloneReasoningText(record);
    if (reasoning !== undefined) parts.push(reasoning);
  } else {
    const reasoning = grokReasoningText(record);
    if (reasoning !== undefined) parts.push(reasoning);
    const prose = extractGrokProse(record);
    if (prose !== undefined) parts.push(prose);
  }
  if (parts.length === 0) {
    // Nothing extractable (e.g. an assistant record with tool calls only):
    // fall back to stable serialization so distinct payloads do not collapse.
    parts.push(JSON.stringify(record) ?? "null");
  }
  return `${type}\u0000${parts.join("\u0001")}`;
};

/**
 * Provider-injected context kinds. A user record whose text is one of these is
 * machinery the harness places at a context boundary (session start, context
 * rebuild, skill catalog, compaction request) — never an authored turn. They
 * are excluded from recovery alignment and preserved separately when they carry
 * information that would otherwise be dropped (the continuation summary).
 */
export type GrokInjectedKind =
  | "system_prompt"
  | "user_info"
  | "context_reminder"
  | "skills_reminder"
  | "continuation_summary"
  | "synthetic_compaction_instruction"
  | "synthetic_recap_instruction";

/** Markers for the synthetic final instruction a request appends for the model. */
export const GROK_COMPACTION_INSTRUCTION_MARKER =
  "Your task is to produce a faithful, concise summary of the conversation so far";
export const GROK_RECAP_INSTRUCTION_MARKER =
  "<system-reminder>Write ONE sentence recap body for a user returning from idle.";

/**
 * Text of one raw chat entry, for machinery-marker checks only. Deliberately
 * minimal (content string / content[].text / summary[].text) so classification
 * never depends on the projection path it is classifying.
 */
export const grokEntryRawText = (value: unknown): string | undefined => {
  const record = recordFrom(value);
  if (record === undefined) return undefined;
  const leaf = (content: unknown): string | undefined => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const parts = content.flatMap((item) =>
        item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
          ? [(item as Record<string, unknown>).text as string]
          : [],
      );
      return parts.length > 0 ? parts.join("") : undefined;
    }
    if (content !== null && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string") {
      return (content as Record<string, unknown>).text as string;
    }
    return undefined;
  };
  if (record.content !== undefined) {
    const text = leaf(record.content);
    if (text !== undefined && text.trim().length > 0) return text;
  }
  if (Array.isArray(record.summary)) {
    const parts = record.summary.flatMap((item) =>
      item !== null && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string"
        ? [(item as Record<string, unknown>).text as string]
        : [],
    );
    const joined = parts.join("");
    if (joined.trim().length > 0) return joined;
  }
  if (typeof record.text === "string") return record.text;
  return undefined;
};

/** Classify a raw chat entry as provider-injected machinery, if it is. */
export const grokInjectedKind = (value: unknown): GrokInjectedKind | undefined => {
  const record = recordFrom(value);
  if (record === undefined) return undefined;
  const type = stringValue(record.type);
  if (type === "system") return "system_prompt";
  if (type !== "user") return undefined;
  const text = grokEntryRawText(value);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  if (trimmed.startsWith("<user_info>")) return "user_info";
  if (trimmed.startsWith(GROK_RECAP_INSTRUCTION_MARKER)) return "synthetic_recap_instruction";
  if (trimmed.startsWith(GROK_COMPACTION_INSTRUCTION_MARKER)) return "synthetic_compaction_instruction";
  if (trimmed.startsWith("<system-reminder>")) {
    return /The following skills are available|## Available Skills/.test(trimmed)
      ? "skills_reminder"
      : "context_reminder";
  }
  if (trimmed.startsWith("This session is being continued from a previous conversation")) {
    return "continuation_summary";
  }
  return undefined;
};

/**
 * Validate a request's final synthetic instruction. Returns the synthetic kind
 * ONLY when the LAST entry is a user record whose text matches a documented
 * instruction marker; a non-matching final line is authored product text and is
 * never dropped.
 */
export const grokSyntheticInstructionKind = (
  value: unknown,
): "compaction" | "recap" | undefined => {
  const kind = grokInjectedKind(value);
  if (kind === "synthetic_compaction_instruction") return "compaction";
  if (kind === "synthetic_recap_instruction") return "recap";
  return undefined;
};
