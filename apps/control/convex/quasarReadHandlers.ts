import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { boundedLimit } from "./quasarValues";

const SESSION_VIEW_LIMIT = 500;
const FILTER_SCAN_MULTIPLIER = 20;

export const listImportRunsHandler = async (ctx: QueryCtx) =>
  await ctx.db.query("importRuns").withIndex("by_createdAt").order("desc").take(50);

export const listSessionsHandler = async (
  ctx: QueryCtx,
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    agentName?: string;
    cursor?: string | null;
    limit?: number;
  },
) => {
  const limit = boundedLimit(args.limit);
  const page = await sessionPage(ctx, args, limit);
  return {
    items: page.page.filter((session) => matchesSessionFilters(session, args)).map((session) => ({
      id: session.sessionId,
      nativeSessionId: session.nativeSessionId,
      title: session.title,
      provider: session.provider,
      agentName: session.agentName,
      machineId: session.machineId,
      projectIdentityKey: session.canonicalProjectIdentityKey,
      eventCount: session.eventCount,
      updatedAt: session.updatedAt,
      ingestState: session.ingestState,
      importJobId: session.importJobId,
    })),
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
};

const matchesSessionFilters = (
  session: {
    canonicalProjectIdentityKey: string;
    projectIdentityKey: string;
    machineId: string;
    provider: string;
    agentName: string;
  },
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    agentName?: string;
  },
) =>
  (args.projectIdentityKey === undefined ||
    session.canonicalProjectIdentityKey === args.projectIdentityKey ||
    session.projectIdentityKey === args.projectIdentityKey) &&
  (args.machineId === undefined || session.machineId === args.machineId) &&
  (args.provider === undefined || session.provider === args.provider) &&
  (args.agentName === undefined || session.agentName === args.agentName);

const sessionPage = async (
  ctx: QueryCtx,
  args: {
    projectIdentityKey?: string;
    machineId?: string;
    provider?: string;
    agentName?: string;
    cursor?: string | null;
  },
  limit: number,
) => {
  const paginationOpts = { cursor: args.cursor ?? null, numItems: limit };
  if (
    args.projectIdentityKey !== undefined &&
    args.provider !== undefined &&
    args.machineId !== undefined
  ) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_project_provider_machine", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("provider", args.provider as never)
          .eq("machineId", args.machineId!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.provider !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_project_provider", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("provider", args.provider as never),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.machineId !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_project_machine", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("machineId", args.machineId!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.agentName !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_project_agent", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("agentName", args.agentName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined && args.machineId !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_provider_machine", (q) =>
        q.eq("provider", args.provider as never).eq("machineId", args.machineId!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined && args.agentName !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_provider_agent", (q) =>
        q.eq("provider", args.provider as never).eq("agentName", args.agentName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_project", (q) =>
        q.eq("canonicalProjectIdentityKey", args.projectIdentityKey!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.machineId !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId!))
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider as never))
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.agentName !== undefined) {
    return await ctx.db
      .query("sessions")
      .withIndex("by_agent", (q) => q.eq("agentName", args.agentName!))
      .order("desc")
      .paginate(paginationOpts);
  }
  return await ctx.db
    .query("sessions")
    .withIndex("by_updatedAt")
    .order("desc")
    .paginate(paginationOpts);
};

export const readSessionHandler = async (
  ctx: QueryCtx,
  args: {
    sessionId: string;
    view?: string;
    leafEventId?: string;
    eventCursor?: string | null;
    contentBlockCursor?: string | null;
    toolCallCursor?: string | null;
    edgeCursor?: string | null;
    usageCursor?: string | null;
    artifactCursor?: string | null;
    limit?: number;
  },
) => {
  const session = await ctx.db
    .query("sessions")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .unique();
  if (session === null) return null;
  const limit = Math.min(SESSION_VIEW_LIMIT, Math.max(1, Math.trunc(args.limit ?? SESSION_VIEW_LIMIT)));
  const eventPage = await ctx.db
    .query("sessionEvents")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.eventCursor ?? null, numItems: limit });
  const events = eventPage.page;
  const toolCallPage = await ctx.db
    .query("toolCalls")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.toolCallCursor ?? null, numItems: limit });
  const toolCalls = toolCallPage.page;
  const contentBlockPage = await ctx.db
    .query("contentBlocks")
    .withIndex("by_session_sequence", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.contentBlockCursor ?? null, numItems: limit });
  const contentBlocks = contentBlockPage.page;
  const edgePage = await ctx.db
    .query("sessionEdges")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.edgeCursor ?? null, numItems: limit });
  const sessionEdges = edgePage.page;
  const usagePage = await ctx.db
    .query("usageRecords")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.usageCursor ?? null, numItems: limit });
  const usageRecords = usagePage.page;
  const artifactPage = await ctx.db
    .query("artifacts")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
    .paginate({ cursor: args.artifactCursor ?? null, numItems: limit });
  const artifacts = artifactPage.page;
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
    pagination: {
      bounded: true,
      limit,
      eventsTruncated: session.eventCount > events.length,
      toolCallsTruncated: session.toolCallCount > toolCalls.length,
      events: {
        isDone: eventPage.isDone,
        continueCursor: eventPage.continueCursor,
      },
      contentBlocks: pageCursor(contentBlockPage),
      toolCalls: pageCursor(toolCallPage),
      sessionEdges: pageCursor(edgePage),
      usageRecords: pageCursor(usagePage),
      artifacts: pageCursor(artifactPage),
    },
    views: {
      chronological: materializeChronologicalView(orderedEvents, orderedBlocks),
      branch: materializeBranchView(orderedEvents, sessionEdges, args.leafEventId),
      toolExpanded: materializeToolExpandedView(orderedEvents, toolCalls),
      selected: args.view ?? "chronological",
    },
  };
};

const pageCursor = (page: { isDone: boolean; continueCursor: string }) => ({
  isDone: page.isDone,
  continueCursor: page.continueCursor,
});

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
    cursor?: string | null;
    limit?: number;
  },
) => {
  const limit = boundedLimit(args.limit);
  if (args.toolCallId !== undefined) {
    const rows = await ctx.db
      .query("toolCalls")
      .withIndex("by_toolCallId", (q) => q.eq("toolCallId", args.toolCallId!))
      .take(boundedScanLimit(limit));
    return {
      items: filterToolCalls(rows, args),
      isDone: true,
      continueCursor: "",
    };
  }
  const page = await toolCallPage(ctx, args, limit);
  return {
    items: page.page.filter((toolCall) => matchesToolCallFilters(toolCall, args)),
    isDone: page.isDone,
    continueCursor: page.continueCursor,
  };
};

const toolCallPage = async (
  ctx: QueryCtx,
  args: Parameters<typeof listToolCallsHandler>[1],
  limit: number,
) => {
  const paginationOpts = { cursor: args.cursor ?? null, numItems: limit };
  if (
    args.projectIdentityKey !== undefined &&
    args.provider !== undefined &&
    args.toolName !== undefined
  ) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project_provider_tool", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("provider", args.provider as never)
          .eq("toolName", args.toolName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.provider !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project_provider", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("provider", args.provider as never),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.toolName !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project_tool", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("toolName", args.toolName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.machineId !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project_machine", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("machineId", args.machineId!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined && args.agentName !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project_agent", (q) =>
        q
          .eq("canonicalProjectIdentityKey", args.projectIdentityKey!)
          .eq("agentName", args.agentName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined && args.toolName !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_provider_tool", (q) =>
        q.eq("provider", args.provider as never).eq("toolName", args.toolName!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined && args.machineId !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_provider_machine", (q) =>
        q.eq("provider", args.provider as never).eq("machineId", args.machineId!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.sessionId !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId!))
      .paginate(paginationOpts);
  }
  if (args.projectIdentityKey !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_project", (q) =>
        q.eq("canonicalProjectIdentityKey", args.projectIdentityKey!),
      )
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.toolName !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_toolName", (q) => q.eq("toolName", args.toolName!))
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.provider !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_provider", (q) => q.eq("provider", args.provider as never))
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.machineId !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_machine", (q) => q.eq("machineId", args.machineId!))
      .order("desc")
      .paginate(paginationOpts);
  }
  if (args.agentName !== undefined) {
    return await ctx.db
      .query("toolCalls")
      .withIndex("by_agent", (q) => q.eq("agentName", args.agentName!))
      .order("desc")
      .paginate(paginationOpts);
  }
  return await ctx.db
    .query("toolCalls")
    .withIndex("by_updatedAt")
    .order("desc")
    .paginate(paginationOpts);
};

const boundedScanLimit = (limit: number) =>
  Math.min(1000, Math.max(limit, limit * FILTER_SCAN_MULTIPLIER));

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
