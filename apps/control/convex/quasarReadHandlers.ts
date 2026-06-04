import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { boundedLimit } from "./quasarValues";

export const listImportRunsHandler = async (ctx: QueryCtx) =>
  await ctx.db.query("importRuns").withIndex("by_createdAt").order("desc").take(50);

export const listSessionsHandler = async (
  ctx: QueryCtx,
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    limit?: number;
  },
) => {
  const limit = boundedLimit(args.limit);
  const rows = await ctx.db.query("sessions").collect();
  return rows
    .filter((session) =>
      args.projectIdentityKey === undefined
        ? true
        : session.canonicalProjectIdentityKey === args.projectIdentityKey ||
          session.projectIdentityKey === args.projectIdentityKey,
    )
    .filter((session) =>
      args.machineId === undefined ? true : session.machineId === args.machineId,
    )
    .filter((session) =>
      args.provider === undefined ? true : session.provider === args.provider,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, limit)
    .map((session) => ({
      id: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      title: session.title,
      provider: session.provider,
      agentName: session.agentName,
      machineId: session.machineId,
      projectIdentityKey: session.canonicalProjectIdentityKey,
      eventCount: session.eventCount,
      updatedAt: session.updatedAt,
    }));
};

export const readSessionHandler = async (
  ctx: QueryCtx,
  args: { sessionId: string; view?: string; leafEventId?: string },
) => {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .unique();
  if (session === null) return null;
  const events = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const toolCalls = await ctx.db
    .query("toolCalls")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const contentBlocks = await ctx.db
    .query("contentBlocks")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const sessionEdges = await ctx.db
    .query("sessionEdges")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const usageRecords = await ctx.db
    .query("usageRecords")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .collect();
  const orderedEvents = events.sort((left, right) => left.sequence - right.sequence);
  const orderedBlocks = contentBlocks.sort((left, right) =>
    left.eventId === right.eventId
      ? left.sequence - right.sequence
      : left.eventId.localeCompare(right.eventId),
  );
  return {
    session,
    events: orderedEvents,
    contentBlocks: orderedBlocks,
    sessionEdges,
    toolCalls,
    usageRecords,
    artifacts,
    views: {
      chronological: materializeChronologicalView(orderedEvents, orderedBlocks),
      branch: materializeBranchView(orderedEvents, sessionEdges, args.leafEventId),
      toolExpanded: materializeToolExpandedView(orderedEvents, toolCalls),
      selected: args.view ?? "chronological",
    },
  };
};

const materializeChronologicalView = (
  events: Doc<"sessionEvents">[],
  contentBlocks: Doc<"contentBlocks">[],
) => {
  const blocksByEvent = groupBy(contentBlocks, (block) => block.eventId);
  return events.map((event) => ({
    eventId: event.eventId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    role: event.role,
    kind: event.kind,
    toolCallId: event.toolCallId,
    contentText: event.contentText,
    contentBlocks: blocksByEvent.get(event.eventId) ?? [],
  }));
};

const materializeBranchView = (
  events: Doc<"sessionEvents">[],
  edges: Doc<"sessionEdges">[],
  requestedLeafEventId: string | undefined,
) => {
  const eventsById = new Map(events.map((event) => [event.eventId, event]));
  const parentByChild = new Map<string, string>();
  for (const edge of edges) {
    if (
      (edge.kind === "parent" ||
        edge.kind === "forked_from" ||
        edge.kind === "compacted_into") &&
      edge.fromEventId !== undefined &&
      edge.toEventId !== undefined
    ) {
      parentByChild.set(edge.toEventId, edge.fromEventId);
    }
  }
  for (const event of events) {
    if (event.parentEventId !== undefined && !parentByChild.has(event.eventId)) {
      parentByChild.set(event.eventId, event.parentEventId);
    }
  }
  const leafEventId = requestedLeafEventId ?? events.at(-1)?.eventId;
  if (leafEventId === undefined) return [];
  const path: Doc<"sessionEvents">[] = [];
  const seen = new Set<string>();
  let current: string | undefined = leafEventId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const event = eventsById.get(current);
    if (event === undefined) break;
    path.push(event);
    current = parentByChild.get(current);
  }
  return path.reverse();
};

const materializeToolExpandedView = (
  events: Doc<"sessionEvents">[],
  toolCalls: Doc<"toolCalls">[],
) => {
  const byToolCallId = new Map(toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall]));
  const byEventId = groupBy(toolCalls, (toolCall) => toolCall.eventId);
  return events.map((event) => ({
    event,
    toolCall:
      event.toolCallId === undefined
        ? undefined
        : byToolCallId.get(event.toolCallId),
    relatedToolCalls: byEventId.get(event.eventId) ?? [],
  }));
};

const groupBy = <T>(items: T[], keyFor: (item: T) => string) => {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  return grouped;
};

export const listToolCallsHandler = async (
  ctx: QueryCtx,
  args: {
    toolCallId?: string;
    sessionId?: string;
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    agentName?: string;
    toolName?: string;
    limit?: number;
  },
) => {
  if (args.toolCallId !== undefined) {
    const rows = await ctx.db
      .query("toolCalls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId!))
      .collect();
    return filterToolCalls(rows, args);
  }
  const rows =
    args.sessionId === undefined
      ? await ctx.db.query("toolCalls").collect()
      : await ctx.db
          .query("toolCalls")
          .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId!))
          .collect();
  return rows
    .filter((toolCall) => matchesToolCallFilters(toolCall, args))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, boundedLimit(args.limit));
};

const filterToolCalls = (
  rows: Doc<"toolCalls">[],
  args: Parameters<typeof listToolCallsHandler>[1],
) =>
  rows
    .filter((toolCall) => matchesToolCallFilters(toolCall, args))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, boundedLimit(args.limit));

const matchesToolCallFilters = (
  toolCall: {
    projectIdentityKey: string;
    canonicalProjectIdentityKey: string;
    machineId: string;
    provider: string;
    agentName: string;
    toolName: string;
  },
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    agentName?: string;
    toolName?: string;
  },
) =>
  (args.projectIdentityKey === undefined ||
    toolCall.projectIdentityKey === args.projectIdentityKey ||
    toolCall.canonicalProjectIdentityKey === args.projectIdentityKey) &&
  (args.machineId === undefined || toolCall.machineId === args.machineId) &&
  (args.provider === undefined || toolCall.provider === args.provider) &&
  (args.agentName === undefined || toolCall.agentName === args.agentName) &&
  (args.toolName === undefined || toolCall.toolName === args.toolName);
