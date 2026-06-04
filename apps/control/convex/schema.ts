import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const provider = v.union(
  v.literal("codex"),
  v.literal("claude"),
  v.literal("opencode"),
  v.literal("grok"),
  v.literal("amp"),
  v.literal("pi"),
  v.literal("kimi"),
  v.literal("droid"),
  v.literal("antigravity"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("unknown"),
);

const confidence = v.union(
  v.literal("explicit"),
  v.literal("high"),
  v.literal("medium"),
  v.literal("low"),
);

const role = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
  v.literal("tool"),
  v.literal("thinking"),
  v.literal("unknown"),
);

const eventKind = v.union(
  v.literal("message"),
  v.literal("tool_call"),
  v.literal("tool_result"),
  v.literal("reasoning"),
  v.literal("system"),
  v.literal("summary"),
  v.literal("edit"),
  v.literal("snapshot"),
  v.literal("lifecycle"),
  v.literal("unknown"),
);

const searchFamily = v.union(
  v.literal("sessions"),
  v.literal("sessionEvents"),
  v.literal("toolCalls"),
  v.literal("projectIdentities"),
);

const ragSyncState = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("skipped"),
  v.literal("failed"),
);

export default defineSchema({
  machines: defineTable({
    machineId: v.string(),
    hostname: v.optional(v.string()),
    tailscaleName: v.optional(v.string()),
    platform: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_machineId", ["machineId"]),

  agentDefinitions: defineTable({
    provider,
    agentName: v.string(),
    displayName: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_provider_and_agentName", ["provider", "agentName"]),

  projectIdentities: defineTable({
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    displayName: v.string(),
    confidence,
    rawPath: v.optional(v.string()),
    normalizedPath: v.optional(v.string()),
    gitRemote: v.optional(v.string()),
    gitRemoteNormalized: v.optional(v.string()),
    packageName: v.optional(v.string()),
    signals: v.array(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_projectIdentityKey", ["projectIdentityKey"])
    .index("by_canonicalProjectIdentityKey", ["canonicalProjectIdentityKey"]),

  projectAliases: defineTable({
    sourceProjectIdentityKey: v.string(),
    targetProjectIdentityKey: v.string(),
    reason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sourceProjectIdentityKey", ["sourceProjectIdentityKey"])
    .index("by_targetProjectIdentityKey", ["targetProjectIdentityKey"]),

  sourceRoots: defineTable({
    provider,
    adapterId: v.string(),
    rootPath: v.string(),
    machineId: v.string(),
    discoveredAt: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_machine_provider_root", ["machineId", "provider", "rootPath"]),

  sessions: defineTable({
    sessionId: v.string(),
    nativeSessionId: v.string(),
    provider,
    agentName: v.string(),
    machineId: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    nativeProjectKey: v.optional(v.string()),
    title: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    updatedAtNative: v.optional(v.string()),
    sourceRoot: v.string(),
    sourcePath: v.string(),
    rawMetadata: v.optional(v.any()),
    eventCount: v.number(),
    toolCallCount: v.number(),
    importRunId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_machine", ["machineId", "updatedAt"])
    .index("by_provider", ["provider", "updatedAt"]),

  sessionEvents: defineTable({
    eventId: v.string(),
    sessionId: v.string(),
    nativeEventId: v.optional(v.string()),
    sequence: v.number(),
    timestamp: v.optional(v.string()),
    machineId: v.string(),
    provider,
    agentName: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    role,
    kind: eventKind,
    contentText: v.optional(v.string()),
    content: v.optional(v.any()),
    toolCallId: v.optional(v.string()),
    parentEventId: v.optional(v.string()),
    rawReference: v.any(),
    raw: v.optional(v.any()),
    importRunId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_session_sequence", ["sessionId", "sequence"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_kind", ["kind", "updatedAt"])
    .index("by_role", ["role", "updatedAt"]),

  toolCalls: defineTable({
    toolCallId: v.string(),
    sessionId: v.string(),
    eventId: v.string(),
    machineId: v.string(),
    provider,
    agentName: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    toolName: v.string(),
    status: v.optional(v.string()),
    input: v.optional(v.any()),
    output: v.optional(v.any()),
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    raw: v.optional(v.any()),
    importRunId: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_toolCallId", ["toolCallId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_toolName", ["toolName", "updatedAt"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"]),

  artifacts: defineTable({
    artifactId: v.string(),
    sessionId: v.string(),
    machineId: v.string(),
    provider,
    kind: v.string(),
    path: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_sessionId", ["sessionId"]),

  importRuns: defineTable({
    importRunId: v.string(),
    machineId: v.string(),
    status: v.union(v.literal("succeeded"), v.literal("partial_failure"), v.literal("failed")),
    sourceRootCount: v.number(),
    sessionCount: v.number(),
    eventCount: v.number(),
    toolCallCount: v.number(),
    diagnostics: v.array(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_importRunId", ["importRunId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_machineId", ["machineId"]),

  searchDocuments: defineTable({
    searchDocumentId: v.string(),
    sourceTable: searchFamily,
    sourceId: v.string(),
    family: searchFamily,
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    machineId: v.string(),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
    role: v.optional(role),
    kind: v.optional(eventKind),
    toolName: v.optional(v.string()),
    title: v.string(),
    summary: v.optional(v.string()),
    searchText: v.string(),
    searchTextHash: v.string(),
    sourcePath: v.optional(v.string()),
    sourceRef: v.optional(v.any()),
    occurredAt: v.optional(v.number()),
    activeProject: v.string(),
    activeMachine: v.string(),
    activeProvider: v.optional(v.string()),
    activeKind: v.optional(v.string()),
    ragEntryId: v.optional(v.string()),
    ragContentHash: v.optional(v.string()),
    ragSyncState: v.optional(ragSyncState),
    ragSyncedAt: v.optional(v.number()),
    ragError: v.optional(v.string()),
    sourceUpdatedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_searchDocumentId", ["searchDocumentId"])
    .index("by_sourceTable_and_sourceId", ["sourceTable", "sourceId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: [
        "canonicalProjectIdentityKey",
        "activeProject",
        "activeMachine",
        "activeProvider",
        "activeKind",
      ],
    }),
});
