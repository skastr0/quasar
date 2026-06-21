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
import { KimiWireRecordSchema } from "./kimi-schema";

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
 * Enumerate every agent declared in state.json that has a readable wire.jsonl.
 *
 * The state.json `agents` dict is the source of truth for which agents exist
 * and their lineage (type + parentAgentId). Each agent reads its OWN
 * agents/<id>/wire.jsonl. An agent declared without a wire file on disk is
 * skipped (no events to project); a wire dir present on disk but absent from
 * state.json is also skipped — state.json is authoritative for lineage, and a
 * wire with no declared agent has no parent to attribute.
 */
const collectAgents = (
  sessionDir: string,
  state: Record<string, unknown>,
): KimiAgent[] => {
  const agentsRecord = recordFrom(state.agents);
  const agents: KimiAgent[] = [];
  for (const id of Object.keys(agentsRecord).sort()) {
    const meta = recordFrom(agentsRecord[id]);
    const wirePath = join(sessionDir, "agents", id, "wire.jsonl");
    if (!existsSync(wirePath)) continue;
    agents.push({
      id,
      type: stringValue(meta.type),
      parentAgentId: stringValue(meta.parentAgentId),
      wirePath,
    });
  }
  return agents;
};

// ---------------------------------------------------------------------------
// Event building for a single agent wire.jsonl
// ---------------------------------------------------------------------------

type AgentLineEvent = {
  readonly lineNumber: number;
  readonly outerTime: number;
  readonly record: Record<string, unknown>;
};

/**
 * Parse a single agent's wire.jsonl into tagged line-events, fail-closed.
 *
 * Every line is decoded through the shared `decodeOrDrop` boundary against
 * `KimiWireRecordSchema`: a malformed record (not an object, non-string `type`)
 * becomes a NAMED diagnostic (`kimi.wire.decode_failed`) in `diagnostics` and is
 * dropped — it never throws (the rest of the wire keeps importing) and never
 * silently coerces a half-record. Lines that fail JSON parse are already dropped
 * by `readJsonLines` upstream; this gate rejects structurally-invalid records.
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
    const record = recordFrom(value);
    const outerTime =
      typeof decision.value.time === "number" && Number.isFinite(decision.value.time)
        ? decision.value.time
        : 0;
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
  // `kind="subagent_of"` edge whose `fromId` is the MAIN session's canonical
  // SessionId and whose `toId` is this sub-agent's own SessionId. This is the
  // purpose-built session-lineage edge — never `parent`, which is event
  // threading. mapSession projects `subagent_of.fromId` onto the served
  // SessionRow.parentSessionId column; the native parent id is kept in
  // rawReference. The main agent emits no such edge (its parentSessionId stays
  // undefined).
  if (!isMain) {
    sessionEdges.push({
      id: edgeIdFor(sessionId, "subagent_of", params.mainSessionId, sessionId),
      kind: "subagent_of",
      fromId: params.mainSessionId,
      toId: sessionId,
      rawReference: {
        sourcePath: agent.wirePath,
        nativeType: "agent",
        agentId: agent.id,
        parentAgentId: agent.parentAgentId ?? "main",
      },
    });
  }

  for (let seq = 0; seq < lineEvents.length; seq++) {
    const { lineNumber, outerTime, record } = lineEvents[seq]!;
    const agentId = agent.id;
    const wirePath = agent.wirePath;
    const outerType = stringValue(record.type) ?? "unknown";
    const outerTimeIso = kimiTime(outerTime !== 0 ? outerTime : undefined);

    const eventId = eventIdFor(sessionId, seq, `${agentId}:${lineNumber}`);

    // -----------------------------------------------------------------------
    // context.append_message — user or system preamble only
    // -----------------------------------------------------------------------
    if (outerType === "context.append_message") {
      const message = recordFrom(record.message);
      const role = stringValue(message.role);
      const originRecord = recordFrom(record.origin ?? message.origin);
      const originKind = stringValue(originRecord.kind) ?? stringValue(record.originKind);
      const isUserOrigin = originKind === "user";

      const contentArr = Array.isArray(message.content) ? message.content : [];
      const textParts = contentArr
        .map((c) => recordFrom(c))
        .flatMap((c) => (stringValue(c.text) !== undefined ? [stringValue(c.text)!] : []));
      const contentText = textParts.length > 0 ? textParts.join(" ") : undefined;

      if (role === "user" && isUserOrigin) {
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "user",
          kind: "message",
          contentText,
          contentSource: contentText,
          rawReference: { sourcePath: wirePath, line: lineNumber, nativeType: outerType, agentId },
        });
      } else {
        eventDrafts.push({
          id: eventId,
          sequence: seq,
          timestamp: outerTimeIso,
          role: "system",
          kind: "preamble",
          contentText,
          contentSource: contentText,
          rawReference: { sourcePath: wirePath, line: lineNumber, nativeType: outerType, agentId },
        });
      }
      continue;
    }

    // -----------------------------------------------------------------------
    // context.append_loop_event — assistant output surface
    // -----------------------------------------------------------------------
    if (outerType === "context.append_loop_event") {
      const event = recordFrom(record.event);
      const eventType = stringValue(event.type) ?? "unknown";

      if (eventType === "content.part") {
        const part = recordFrom(event.part);
        const partType = stringValue(part.type);

        if (partType === "text") {
          const text = stringValue(part.text);
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
        } else if (partType === "think") {
          const think = stringValue(part.think);
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
        } else {
          eventDrafts.push({
            id: eventId,
            sequence: seq,
            timestamp: outerTimeIso,
            role: "unknown",
            kind: "lifecycle",
            rawReference: {
              sourcePath: wirePath,
              line: lineNumber,
              nativeType: `content.part:${partType ?? "unknown"}`,
              agentId,
            },
          });
        }
        continue;
      }

      if (eventType === "tool.call") {
        const toolCallId = stringValue(event.toolCallId);
        const toolName = stringValue(event.name) ?? "kimi_tool";
        const input = projectToolPayloadNativeValue(event.args);
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
        continue;
      }

      if (eventType === "tool.result") {
        const toolCallId = stringValue(event.toolCallId);
        const resultRecord = recordFrom(event.result);
        const output = projectToolPayloadNativeValue(resultRecord.output ?? event.result);
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
        continue;
      }

      eventDrafts.push({
        id: eventId,
        sequence: seq,
        timestamp: outerTimeIso,
        role: "unknown",
        kind: "lifecycle",
        rawReference: {
          sourcePath: wirePath,
          line: lineNumber,
          nativeType: `loop_event:${eventType}`,
          agentId,
        },
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // context.apply_compaction → summary
    // -----------------------------------------------------------------------
    if (
      outerType === "context.apply_compaction" ||
      outerType === "micro_compaction" ||
      outerType === "full_compaction"
    ) {
      const summary = stringValue(record.summary);
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
      continue;
    }

    // -----------------------------------------------------------------------
    // usage.record → UsageRecord
    // -----------------------------------------------------------------------
    if (outerType === "usage.record") {
      const model = stringValue(record.model);
      const usage = recordFrom(record.usage);
      const inputOther =
        typeof usage.inputOther === "number" ? (usage.inputOther as number) : undefined;
      const output =
        typeof usage.output === "number" ? (usage.output as number) : undefined;
      const inputCacheRead =
        typeof usage.inputCacheRead === "number" ? (usage.inputCacheRead as number) : undefined;
      const inputCacheCreation =
        typeof usage.inputCacheCreation === "number"
          ? (usage.inputCacheCreation as number)
          : undefined;

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
      eventDrafts.push({
        id: eventId,
        sequence: seq,
        timestamp: outerTimeIso,
        role: "unknown",
        kind: "lifecycle",
        rawReference: {
          sourcePath: wirePath,
          line: lineNumber,
          nativeType: "usage.record",
          agentId,
        },
      });
      continue;
    }

    // -----------------------------------------------------------------------
    // All other outer types → lifecycle
    // -----------------------------------------------------------------------
    eventDrafts.push({
      id: eventId,
      sequence: seq,
      timestamp: outerTimeIso,
      role: "unknown",
      kind: "lifecycle",
      rawReference: {
        sourcePath: wirePath,
        line: lineNumber,
        nativeType: outerType,
        agentId,
      },
    });
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
  const agents = collectAgents(entry.sessionDir, state);

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

    // Pre-parse gate keys off the MAIN session id. The whole agent tree shares
    // one state.json fingerprint, so a hit skips the entire entry (main + subs)
    // together — they always change together.
    if (options.shouldParseSession !== undefined) {
      const stateJsonPath = join(sessionDir, "state.json");
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

    const stateJsonPath = join(sessionDir, "state.json");
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
