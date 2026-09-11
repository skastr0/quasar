import { decodeMappedSessionSync, messageContentHash, NORMALIZED_SESSION_PROTOCOL_VERSION } from "@skastr0/quasar-protocol";

import type { SessionId } from "../core/identity";
import type { MappedSession } from "../model";
import { contentBlockIdFor, eventIdFor } from "./common";
import {
  countExcessMessageOccurrences,
  planGrokEpochMerge,
  verifyToolCallRetention,
  type GrokEpochMergePlan,
} from "./grok-recovery";

export type GrokEpochMappedMerge = {
  readonly plan: GrokEpochMergePlan;
  readonly session?: MappedSession;
};

const isChatHistoryEvent = (sourcePath: string | undefined): boolean =>
  sourcePath !== undefined && sourcePath.endsWith("chat_history.jsonl");

/**
 * Identity-preserving merge: every stored fact is copied verbatim, then
 * live-epoch source-only messages/tools and their backing chat events are
 * appended with sequences above the stored prefix. Event ids are reminted
 * only when they collide with the stored prefix. Does not write.
 */
export const mergeGrokEpochMappedSessions = (
  stored: MappedSession,
  current: MappedSession,
  options?: {
    readonly sourceFingerprint?: string;
    readonly sourcePath?: string;
  },
): GrokEpochMappedMerge => {
  const storedEventIds = new Set(stored.events.map((event) => event.id));
  const storedBlockIds = new Set(
    stored.events.flatMap((event) => event.contentBlocks.map((block) => block.id)),
  );
  const storedMaxSeq = Math.max(
    0,
    ...stored.events.map((event) => event.sequence),
    ...stored.messages.map((message) => message.seq),
    ...stored.toolCalls.map((tool) => tool.seq),
  );
  const plan = planGrokEpochMerge({
    storedMessages: stored.messages,
    storedTools: stored.toolCalls,
    currentMessages: current.messages,
    currentTools: current.toolCalls,
    storedEventIds: [...storedEventIds],
    storedMaxSeq,
  });
  if (!plan.safe) return { plan };

  const machineId = stored.events[0]?.machineId ?? current.events[0]?.machineId;
  const withMachine = <A extends { readonly machineId: string }>(fact: A): A =>
    machineId === undefined || fact.machineId === machineId
      ? fact
      : { ...fact, machineId };
  const currentEventById = new Map(current.events.map((event) => [event.id, event]));
  const sharedCurrentToStored = new Map<string, string>();
  for (const [offset, currentIndex] of plan.classification.sharedCurrentIndexes.entries()) {
    const storedIndex = plan.classification.sharedStoredIndexes[offset];
    if (storedIndex === undefined) continue;
    sharedCurrentToStored.set(
      current.messages[currentIndex]!.eventId,
      stored.messages[storedIndex]!.eventId,
    );
  }
  const eventIdRemap = new Map<string, string>();
  const canonicalEventId = (id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    return eventIdRemap.get(id) ?? sharedCurrentToStored.get(id) ?? id;
  };
  const appendedEvents: MappedSession["events"][number][] = [];
  const appendEvent = (
    sourceId: string,
    nextSeq: number,
  ): { readonly id: string; readonly seq: number } | undefined => {
    if (eventIdRemap.has(sourceId)) {
      const remapped = eventIdRemap.get(sourceId)!;
      const existing = appendedEvents.find((event) => event.id === remapped);
      return existing === undefined ? undefined : { id: existing.id, seq: existing.sequence };
    }
    if (sharedCurrentToStored.has(sourceId)) return undefined;
    const source = currentEventById.get(sourceId);
    if (source === undefined) return undefined;
    if (
      !isChatHistoryEvent(source.rawReference.sourcePath)
      && !plan.appendCurrentMessageIndexes.some((index) => current.messages[index]!.eventId === sourceId)
    ) {
      return undefined;
    }
    const id = storedEventIds.has(source.id)
      ? eventIdFor(stored.session.sessionId as SessionId, nextSeq, `epoch-merge:${source.id}`)
      : source.id;
    if (storedEventIds.has(id)) return undefined;
    eventIdRemap.set(sourceId, id);
    const parentEventId = canonicalEventId(source.parentEventId);
    const { parentEventId: _ignoredParent, ...sourceWithoutParent } = source;
    appendedEvents.push(withMachine({
      ...sourceWithoutParent,
      id,
      sessionId: stored.session.sessionId,
      sequence: nextSeq,
      contentBlocks: source.contentBlocks.map((block, index) => {
        const sequence = block.sequence ?? index;
        const blockId = contentBlockIdFor(stored.session.sessionId as SessionId, id, sequence);
        storedBlockIds.add(blockId);
        return { ...block, id: blockId, sequence };
      }),
      ...(parentEventId !== undefined ? { parentEventId } : {}),
    }));
    storedEventIds.add(id);
    return { id, seq: nextSeq };
  };

  let nextSeq = storedMaxSeq;
  const appendedMessages: MappedSession["messages"][number][] = [];
  for (const index of plan.appendCurrentMessageIndexes) {
    const message = current.messages[index]!;
    nextSeq += 1;
    const mappedEvent = appendEvent(message.eventId, nextSeq);
    if (mappedEvent === undefined) {
      return {
        plan: {
          ...plan,
          safe: false,
          blockers: [...plan.blockers, `missing_current_event:${message.eventId}`],
        },
      };
    }
    if (mappedEvent.seq !== nextSeq) nextSeq = mappedEvent.seq;
    appendedMessages.push({
      ...message,
      sessionId: stored.session.sessionId,
      projectKey: stored.session.projectKey,
      eventId: mappedEvent.id,
      seq: mappedEvent.seq,
      contentHash: messageContentHash({
        sessionId: stored.session.sessionId,
        eventId: mappedEvent.id,
        seq: mappedEvent.seq,
        role: message.role,
        text: message.text,
      }),
    });
  }

  const storedContextIds = new Set(stored.executionContexts.map((context) => context.id));
  const appendedContexts: MappedSession["executionContexts"][number][] = [];
  const adoptContext = (contextId: string | undefined) => {
    if (contextId === undefined || storedContextIds.has(contextId)) return;
    const context = current.executionContexts.find((row) => row.id === contextId);
    if (context === undefined) return;
    appendedContexts.push(withMachine({ ...context, sessionId: stored.session.sessionId }));
    storedContextIds.add(contextId);
  };

  const appendedTools: MappedSession["toolCalls"][number][] = [];
  const appendToolIds = new Set(plan.appendCurrentToolIds);
  for (const tool of current.toolCalls) {
    if (!appendToolIds.has(tool.id)) continue;
    let mappedEvent = eventIdRemap.has(tool.eventId)
      ? (() => {
        const id = eventIdRemap.get(tool.eventId)!;
        const event = appendedEvents.find((row) => row.id === id);
        return event === undefined ? undefined : { id: event.id, seq: event.sequence };
      })()
      : undefined;
    if (mappedEvent === undefined) {
      nextSeq += 1;
      mappedEvent = appendEvent(tool.eventId, nextSeq);
    }
    if (mappedEvent === undefined) {
      return {
        plan: {
          ...plan,
          safe: false,
          blockers: [...plan.blockers, `missing_current_tool_event:${tool.id}`],
        },
      };
    }
    appendedTools.push({
      ...tool,
      sessionId: stored.session.sessionId,
      projectKey: stored.session.projectKey,
      provider: stored.session.provider,
      eventId: mappedEvent.id,
      seq: mappedEvent.seq,
    });
    adoptContext(tool.executionContextId);
  }
  for (const message of appendedMessages) adoptContext(message.executionContextId);

  const appendedEventIds = new Set(appendedEvents.map((event) => event.id));
  const storedUsageIds = new Set(stored.usageRecords.map((row) => row.id));
  const appendedUsage = current.usageRecords.flatMap((row) => {
    const eventId = canonicalEventId(row.eventId);
    if (eventId === undefined || !appendedEventIds.has(eventId) || storedUsageIds.has(row.id)) return [];
    return [withMachine({ ...row, sessionId: stored.session.sessionId, eventId })];
  });
  const storedArtifactIds = new Set(stored.artifacts.map((row) => row.id));
  const appendedArtifacts = current.artifacts.flatMap((row) => {
    const eventId = canonicalEventId(row.eventId);
    if (eventId === undefined || !appendedEventIds.has(eventId) || storedArtifactIds.has(row.id)) return [];
    return [withMachine({ ...row, sessionId: stored.session.sessionId, eventId })];
  });
  const storedEdgeIds = new Set(stored.sessionEdges.map((row) => row.id));
  const knownEventIds = new Set([...stored.events.map((event) => event.id), ...appendedEventIds]);
  const appendedEdges = current.sessionEdges.flatMap((row) => {
    if (storedEdgeIds.has(row.id)) return [];
    const fromEventId = canonicalEventId(row.fromEventId);
    const toEventId = canonicalEventId(row.toEventId);
    if (fromEventId !== undefined && !knownEventIds.has(fromEventId)) return [];
    if (toEventId !== undefined && !knownEventIds.has(toEventId)) return [];
    return [withMachine({
      ...row,
      sessionId: stored.session.sessionId,
      ...(fromEventId !== undefined ? { fromEventId } : {}),
      ...(toEventId !== undefined ? { toEventId } : {}),
    })];
  });

  const messages = [...stored.messages, ...appendedMessages];
  const toolCalls = [...stored.toolCalls, ...appendedTools];
  const session: MappedSession = decodeMappedSessionSync({
    ...stored,
    session: {
      ...stored.session,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      sourceFingerprint: options?.sourceFingerprint ?? stored.session.sourceFingerprint,
      sourcePath: options?.sourcePath ?? stored.session.sourcePath,
      ...(current.session.updatedAt !== undefined ? { updatedAt: current.session.updatedAt } : {}),
    },
    messages,
    toolCalls,
    events: [...stored.events, ...appendedEvents],
    usageRecords: [...stored.usageRecords, ...appendedUsage],
    sessionEdges: [...stored.sessionEdges, ...appendedEdges],
    artifacts: [...stored.artifacts, ...appendedArtifacts],
    executionContexts: [...stored.executionContexts, ...appendedContexts],
  });
  return { plan: { ...plan, safe: true }, session };
};

// ---------------------------------------------------------------------------
// Canonical ingest preservation: store-aware union for compacted Grok sessions
// ---------------------------------------------------------------------------

/** Named failure for a preservation attempt that cannot prove a lossless union. */
export class GrokPreserveError extends Error {
  override readonly name = "GrokPreserveError";

  constructor(
    readonly diagnostic: string,
    message: string,
  ) {
    super(message);
  }
}

export type GrokStoredSessionFetch = {
  readonly serverUrl: string;
  readonly ingestToken?: string;
  readonly timeoutMs?: number;
};

export type GrokStoredSessionFetcher = (
  sessionId: string,
  options: GrokStoredSessionFetch,
) => Promise<MappedSession | undefined>;

type StoredPage<T> = {
  readonly rows: readonly T[];
  readonly total: number;
  readonly hasMore: boolean;
};

type StoredSessionDetail = {
  readonly session: MappedSession["session"];
  readonly assignment?: MappedSession["assignment"];
  readonly messages: StoredPage<MappedSession["messages"][number]>;
  readonly toolCalls: StoredPage<MappedSession["toolCalls"][number]>;
  readonly events: StoredPage<MappedSession["events"][number]>;
  readonly usageRecords: StoredPage<MappedSession["usageRecords"][number]>;
  readonly sessionEdges: StoredPage<MappedSession["sessionEdges"][number]>;
  readonly artifacts: StoredPage<MappedSession["artifacts"][number]>;
  readonly executionContexts: StoredPage<MappedSession["executionContexts"][number]>;
};

const baseUrl = (serverUrl: string): URL =>
  new URL(serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);

const fetchEnvelope = async (
  url: URL,
  options: GrokStoredSessionFetch,
): Promise<{ readonly status: number; readonly data?: unknown }> => {
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
    headers["x-quasar-ingest-token"] = options.ingestToken;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (response.status === 404) {
    // A session-not-found 404 carries the server's JSON error envelope. A bare
    // 404 means the read surface itself is missing (older server), which must
    // fail the session closed instead of silently posting a replacement.
    const text = await response.text().catch(() => "");
    let parsed: { readonly ok?: boolean } | undefined;
    try {
      parsed = JSON.parse(text) as { readonly ok?: boolean };
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && parsed.ok === false) return { status: 404 };
    throw new GrokPreserveError(
      "grok.preserve.fetch_failed",
      "stored session read surface is unavailable (bare HTTP 404)",
    );
  }
  if (!response.ok) {
    throw new GrokPreserveError(
      "grok.preserve.fetch_failed",
      `stored session read failed with HTTP ${response.status}`,
    );
  }
  let body: { readonly ok?: boolean; readonly data?: unknown };
  try {
    body = await response.json() as { readonly ok?: boolean; readonly data?: unknown };
  } catch {
    throw new GrokPreserveError("grok.preserve.fetch_failed", "stored session read returned invalid JSON");
  }
  if (body.ok !== true || body.data === undefined) {
    throw new GrokPreserveError("grok.preserve.fetch_failed", "stored session read returned an invalid envelope");
  }
  return { status: response.status, data: body.data };
};

const DETAIL_PAGE_LIMIT = 1_000;

const detailPage = async (
  sessionId: string,
  param: string,
  limit: number,
  offset: number,
  options: GrokStoredSessionFetch,
): Promise<StoredSessionDetail | undefined> => {
  const url = baseUrl(options.serverUrl);
  url.pathname = "/session-detail";
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set(`${param}Limit`, String(limit));
  url.searchParams.set(`${param}Offset`, String(offset));
  const result = await fetchEnvelope(url, options);
  if (result.status === 404) return undefined;
  return result.data as StoredSessionDetail;
};

const gatherCollection = async <T>(
  sessionId: string,
  collection: keyof StoredSessionDetail,
  param: string,
  options: GrokStoredSessionFetch,
): Promise<readonly T[]> => {
  const rows: T[] = [];
  let offset = 0;
  while (true) {
    const detail = await detailPage(sessionId, param, DETAIL_PAGE_LIMIT, offset, options);
    if (detail === undefined) {
      throw new GrokPreserveError(
        "grok.preserve.fetch_failed",
        `stored session disappeared while reading ${collection}`,
      );
    }
    const page = detail[collection] as unknown as StoredPage<T>;
    rows.push(...page.rows);
    if (!page.hasMore || page.rows.length === 0 || rows.length >= page.total) break;
    offset += page.rows.length;
  }
  return rows;
};

/**
 * SQL columns come back as explicit nulls for absent optional fields; the
 * strict MappedSession decode expects absence. Matches the server's own
 * `readMappedSession` normalization for messages and tool calls.
 */
const omitNulls = <T extends object>(row: T): T =>
  Object.fromEntries(Object.entries(row).filter(([, value]) => value !== null)) as T;

const findStoredProject = async (
  projectKey: string,
  options: GrokStoredSessionFetch,
): Promise<MappedSession["project"] | undefined> => {
  let offset = 0;
  while (true) {
    const url = baseUrl(options.serverUrl);
    url.pathname = "/projects";
    url.searchParams.set("limit", String(DETAIL_PAGE_LIMIT));
    url.searchParams.set("offset", String(offset));
    const result = await fetchEnvelope(url, options);
    const rows = ((result.data as { readonly rows?: MappedSession["project"][] }).rows ?? []);
    const found = rows.find((row) => row.projectKey === projectKey);
    if (found !== undefined) return found;
    if (rows.length < DETAIL_PAGE_LIMIT) return undefined;
    offset += rows.length;
  }
};

/**
 * Read the stored canonical MappedSession over the existing read-only
 * `/session-detail` and `/projects` surfaces. No direct database access and no
 * new server API. Returns undefined when the session has never been stored.
 */
export const fetchStoredMappedSession: GrokStoredSessionFetcher = async (sessionId, options) => {
  const head = await detailPage(sessionId, "message", 1, 0, options);
  if (head === undefined) return undefined;
  const project = await findStoredProject(head.session.projectKey, options);
  if (project === undefined) {
    throw new GrokPreserveError(
      "grok.preserve.project_missing",
      `stored project row missing for ${head.session.projectKey}`,
    );
  }
  try {
    return decodeMappedSessionSync({
      protocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
      project,
      session: head.session,
      messages: (await gatherCollection<MappedSession["messages"][number]>(sessionId, "messages", "message", options)).map(omitNulls),
      toolCalls: (await gatherCollection<MappedSession["toolCalls"][number]>(sessionId, "toolCalls", "toolCall", options)).map(omitNulls),
      events: await gatherCollection(sessionId, "events", "event", options),
      usageRecords: await gatherCollection(sessionId, "usageRecords", "usage", options),
      sessionEdges: await gatherCollection(sessionId, "sessionEdges", "edge", options),
      artifacts: await gatherCollection(sessionId, "artifacts", "artifact", options),
      executionContexts: await gatherCollection(sessionId, "executionContexts", "context", options),
      ...(head.assignment !== undefined ? { assignment: head.assignment } : {}),
    });
  } catch (error) {
    if (error instanceof GrokPreserveError) throw error;
    throw new GrokPreserveError(
      "grok.preserve.invalid_stored_session",
      `stored session failed its contract decode: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const storedMaxSequence = (stored: MappedSession): number =>
  Math.max(
    0,
    ...stored.messages.map((row) => row.seq),
    ...stored.toolCalls.map((row) => row.seq),
    ...stored.events.map((event) => event.sequence),
  );

/**
 * Canonical ingest preservation: union the stored canonical prefix with the
 * live post-compaction suffix. The merge function keeps every stored fact
 * verbatim and appends source-only live turns; this wrapper proves the
 * identity/chronology/content invariants, so any gap fails the session closed
 * instead of writing a shorter replacement. `--force` has no bearing here:
 * the caller runs this before the write regardless of force.
 */
export const preserveStoredPrefixWithLiveSuffix = async (options: {
  readonly serverUrl: string;
  readonly mapped: MappedSession;
  readonly ingestToken?: string;
  readonly timeoutMs?: number;
  /** Test seam. */
  readonly fetchStored?: GrokStoredSessionFetcher;
}): Promise<MappedSession> => {
  const current = options.mapped;
  const fetchStored = options.fetchStored ?? fetchStoredMappedSession;
  const stored = await fetchStored(current.session.sessionId, {
    serverUrl: options.serverUrl,
    ...(options.ingestToken !== undefined ? { ingestToken: options.ingestToken } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  if (stored === undefined) return current; // first ingest: nothing stored to preserve

  if (stored.session.sessionId !== current.session.sessionId) {
    throw new GrokPreserveError("grok.preserve.identity_mismatch", "stored session id does not match the live projection");
  }
  if (stored.session.provider !== current.session.provider) {
    throw new GrokPreserveError("grok.preserve.identity_mismatch", "stored and live projections disagree on provider");
  }
  if (stored.session.projectKey !== current.session.projectKey) {
    throw new GrokPreserveError("grok.preserve.identity_mismatch", "stored and live projections disagree on projectKey");
  }
  if (stored.session.normalizationVersion !== current.session.normalizationVersion) {
    throw new GrokPreserveError("grok.preserve.normalization_mismatch", "stored and live projections disagree on normalization version");
  }
  const storedMachine = stored.events[0]?.machineId;
  const currentMachine = current.events[0]?.machineId;
  if (storedMachine !== currentMachine) {
    throw new GrokPreserveError("grok.preserve.machine_mismatch", "stored and live projections disagree on source machine");
  }

  const merged = mergeGrokEpochMappedSessions(stored, current, {
    sourceFingerprint: current.session.sourceFingerprint,
    sourcePath: current.session.sourcePath,
  });
  if (!merged.plan.safe) {
    throw new GrokPreserveError(
      "grok.preserve.unsafe_union",
      `no lossless union: ${merged.plan.blockers.join(",") || "unknown blocker"}`,
    );
  }
  if (merged.session === undefined) {
    throw new GrokPreserveError("grok.preserve.unsafe_union", "merge produced no session");
  }
  const union = merged.session;

  const storedTexts = stored.messages.map((row) => row.text);
  const currentTexts = current.messages.map((row) => row.text);
  const unionTexts = union.messages.map((row) => row.text);
  // Count-based coverage both ways: no stored occurrence lost, no live
  // occurrence lost. The planner's multiplicity proof bounds invented
  // duplicates; identical turns at different positions stay distinct.
  if (countExcessMessageOccurrences(unionTexts, storedTexts) > 0) {
    throw new GrokPreserveError("grok.preserve.content_invariant", "union drops a stored canonical message");
  }
  if (countExcessMessageOccurrences(unionTexts, currentTexts) > 0) {
    throw new GrokPreserveError("grok.preserve.content_invariant", "union drops a live occurrence");
  }
  const toolRetention = verifyToolCallRetention(
    stored.toolCalls.map((tool) => ({
      toolCallId: tool.id,
      sequence: tool.seq,
      toolName: tool.toolName,
      status: tool.status ?? null,
      inputBytes: Buffer.byteLength(tool.inputText, "utf8"),
      outputBytes: Buffer.byteLength(tool.outputText, "utf8"),
    })),
    union.toolCalls.map((tool) => ({
      id: tool.id,
      toolName: tool.toolName,
      status: tool.status ?? null,
      inputText: tool.inputText,
      outputText: tool.outputText,
    })),
  );
  if (
    toolRetention.missing.length > 0
    || toolRetention.toolNameMismatches.length > 0
    || toolRetention.statusMismatches.length > 0
    || toolRetention.byteMismatches.length > 0
    || toolRetention.hashMismatches.length > 0
    || toolRetention.duplicateRecoveredIds.length > 0
  ) {
    throw new GrokPreserveError("grok.preserve.content_invariant", "union does not retain every stored tool call verbatim");
  }

  const maxStoredSeq = storedMaxSequence(stored);
  const storedMessageEventIds = new Set(stored.messages.map((row) => row.eventId));
  const storedToolIds = new Set(stored.toolCalls.map((row) => row.id));
  const storedEventIds = new Set(stored.events.map((event) => event.id));
  for (const message of union.messages) {
    if (!storedMessageEventIds.has(message.eventId) && message.seq <= maxStoredSeq) {
      throw new GrokPreserveError("grok.preserve.chronology_invariant", "appended message lands inside the stored sequence range");
    }
  }
  for (const tool of union.toolCalls) {
    if (!storedToolIds.has(tool.id) && tool.seq <= maxStoredSeq) {
      throw new GrokPreserveError("grok.preserve.chronology_invariant", "appended tool call lands inside the stored sequence range");
    }
  }
  for (const event of union.events) {
    if (!storedEventIds.has(event.id) && event.sequence <= maxStoredSeq) {
      throw new GrokPreserveError("grok.preserve.chronology_invariant", "appended event lands inside the stored sequence range");
    }
  }
  return union;
};
