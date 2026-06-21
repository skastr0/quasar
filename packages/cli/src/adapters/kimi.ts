import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { collectAdapterStream, type AdapterStreamItem, type SessionAdapter } from "./types";
import { KimiSessionId } from "../core/identity";
import type { ToolCall, UsageRecord } from "../core/schemas";
import {
  buildSession,
  compactText,
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

type AdapterOptions = Parameters<SessionAdapter["read"]>[0];

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

/** Enumerate agent wire.jsonl paths for a session directory. */
const collectAgentWirePaths = (sessionDir: string): { agentId: string; wirePath: string }[] => {
  const agentsDir = join(sessionDir, "agents");
  if (!existsSync(agentsDir)) return [];
  const results: { agentId: string; wirePath: string }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(agentsDir);
  } catch {
    return [];
  }
  for (const agentId of entries) {
    const wirePath = join(agentsDir, agentId, "wire.jsonl");
    if (existsSync(wirePath)) {
      results.push({ agentId, wirePath });
    }
  }
  return results;
};

// ---------------------------------------------------------------------------
// Event building for a single agent wire.jsonl
// ---------------------------------------------------------------------------

type AgentLineEvent = {
  readonly agentId: string;
  readonly wirePath: string;
  readonly lineNumber: number;
  readonly outerTime: number;
  readonly record: Record<string, unknown>;
};

/** Parse a single agent's wire.jsonl into a list of tagged line-events. */
const collectAgentLineEvents = (agentId: string, wirePath: string): AgentLineEvent[] => {
  let lines: { value: unknown; lineNumber: number }[];
  try {
    lines = readJsonLines(wirePath);
  } catch {
    return [];
  }
  const result: AgentLineEvent[] = [];
  for (const { value, lineNumber } of lines) {
    const record = recordFrom(value);
    const outerTime =
      typeof record.time === "number" && Number.isFinite(record.time)
        ? record.time
        : 0;
    result.push({ agentId, wirePath, lineNumber, outerTime, record });
  }
  return result;
};

// ---------------------------------------------------------------------------
// Session builder
// ---------------------------------------------------------------------------

const buildKimiSessionFromEntry = (
  entry: { sessionId: string; sessionDir: string; workDir: string },
  sessionsRoot: string,
  options: AdapterOptions,
) => {
  const nativeSessionId = KimiSessionId(entry.sessionId);
  const sessionId = sessionIdFor("kimi", nativeSessionId);
  const stateJsonPath = join(entry.sessionDir, "state.json");
  const stateRaw = readJsonFile(stateJsonPath);
  const state = recordFrom(stateRaw);

  // Extract title from state.json.
  const isCustomTitle = state.isCustomTitle === true;
  const title = isCustomTitle ? stringValue(state.title) : undefined;
  const createdAt = stringValue(state.createdAt);
  const updatedAt = stringValue(state.updatedAt);

  // Collect all agents' wire.jsonl paths.
  const agentWires = collectAgentWirePaths(entry.sessionDir);

  // Gather all line-events across agents, then sort by (outerTime, agentId, lineNumber).
  const allLineEvents: AgentLineEvent[] = [];
  for (const { agentId, wirePath } of agentWires) {
    const events = collectAgentLineEvents(agentId, wirePath);
    for (const ev of events) allLineEvents.push(ev);
  }
  allLineEvents.sort((a, b) => {
    if (a.outerTime !== b.outerTime) return a.outerTime - b.outerTime;
    if (a.agentId !== b.agentId) return a.agentId < b.agentId ? -1 : 1;
    return a.lineNumber - b.lineNumber;
  });

  // Map events, maintain tool-call drafts keyed by toolCallId.
  const toolCallsById = new Map<string, KimiToolCallDraft>();
  const usageDrafts: KimiUsageDraft[] = [];
  const eventDrafts: KimiEventDraft[] = [];

  for (let seq = 0; seq < allLineEvents.length; seq++) {
    const { agentId, wirePath, lineNumber, outerTime, record } = allLineEvents[seq]!;
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

      // Extract text from message.content[].text
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
        // Non-user origin → preamble / system context
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
          // Other part types → lifecycle
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
          // Unmatched tool result — create a minimal record
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

      // step.begin / step.end / other loop events → lifecycle
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
      // Also emit a lifecycle event so the sequence is preserved
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
    agentName: "kimi-code",
    machine: options.machine,
    sessionId,
    nativeSessionId,
    projectPath: entry.workDir.length > 0 ? entry.workDir : undefined,
    title,
    startedAt: createdAt,
    updatedAt,
    sourceRoot: sessionsRoot,
    sourcePath: entry.sessionDir,
    events: eventDrafts,
    toolCalls: [...toolCallsById.values()],
    usageRecords: usageDrafts,
  });
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

  // The sessions directory is the sourceRoot for all sessions.
  const sessionsRoot = join(root, "sessions");

  const rootRecord = sourceRoot("kimi", kimiAdapter.id, sessionsRoot, options.machine, options.now);
  yield { type: "sourceRoot", sourceRoot: rootRecord };

  // Parse the session index.
  const indexLines = readJsonLines(indexPath);
  let sessionCount = 0;
  let skipped = 0;

  for (const { value } of indexLines) {
    const entry = recordFrom(value);
    const sessionId = stringValue(entry.sessionId);
    const sessionDir = stringValue(entry.sessionDir);
    const workDir = stringValue(entry.workDir) ?? "";

    if (sessionId === undefined || sessionDir === undefined) continue;
    if (!existsSync(sessionDir)) continue;

    // Skip / limit support
    if (skipped < (options.skip ?? 0)) { skipped++; continue; }
    if (sessionCount >= (options.limit ?? Number.POSITIVE_INFINITY)) break;

    // Pre-parse gate: skip sessions that have not changed since last ingest.
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

    const session = buildKimiSessionFromEntry(
      { sessionId, sessionDir, workDir },
      sessionsRoot,
      options,
    );

    const stateJsonPath = join(sessionDir, "state.json");
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
