import { decodeMappedSessionSync, messageContentHash } from "@skastr0/quasar-protocol";

import type { SessionId } from "../core/identity";
import type { MappedSession } from "../model";
import { contentBlockIdFor, eventIdFor } from "./common";
import {
  planGrokEpochMerge,
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
