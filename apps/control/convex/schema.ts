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
  v.literal("hermes"),
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
  v.literal("developer"),
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
  v.literal("preamble"),
  v.literal("system"),
  v.literal("summary"),
  v.literal("edit"),
  v.literal("snapshot"),
  v.literal("lifecycle"),
  v.literal("usage"),
  v.literal("unknown"),
);

const contentBlockKind = v.union(
  v.literal("text"),
  v.literal("markdown"),
  v.literal("thinking"),
  v.literal("image"),
  v.literal("file"),
  v.literal("json"),
);

const rawReference = v.object({
  sourcePath: v.string(),
  line: v.optional(v.number()),
  table: v.optional(v.string()),
  rowId: v.optional(v.string()),
  nativeType: v.optional(v.string()),
});
const sessionEdgeKind = v.union(
  v.literal("next"),
  v.literal("parent"),
  v.literal("tool_result_for"),
  v.literal("forked_from"),
  v.literal("subagent_of"),
  v.literal("compacted_into"),
  v.literal("artifact_of"),
);

const searchFamily = v.union(
  v.literal("sessions"),
  v.literal("sessionEvents"),
  v.literal("contentBlocks"),
  v.literal("toolCalls"),
  v.literal("artifacts"),
  v.literal("projectIdentities"),
);

const ingestedRecordType = v.union(
  v.literal("session"),
  v.literal("event"),
  v.literal("content_block"),
  v.literal("tool_call"),
  v.literal("usage"),
  v.literal("artifact"),
  v.literal("edge"),
  v.literal("source_root"),
);

const ragSyncState = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("skipped"),
  v.literal("failed"),
  v.literal("dead_letter"),
);

const embeddingOutboxStatus = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("dead_letter"),
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
    .index("by_canonicalProjectIdentityKey", ["canonicalProjectIdentityKey"])
    .index("by_updatedAt", ["updatedAt"]),

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
    sourceRootId: v.optional(v.string()),
    provider,
    adapterId: v.string(),
    rootPath: v.string(),
    machineId: v.string(),
    discoveredAt: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sourceRootId", ["sourceRootId"])
    .index("by_machine_provider_root", ["machineId", "provider", "rootPath"]),

  recordStates: defineTable({
    recordKey: v.string(),
    recordType: ingestedRecordType,
    recordId: v.string(),
    machineId: v.string(),
    contentHash: v.string(),
    tombstoned: v.boolean(),
    lastSeenAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_recordKey", ["recordKey"])
    .index("by_updatedAt", ["updatedAt"]),

  tombstones: defineTable({
    recordKey: v.string(),
    recordType: ingestedRecordType,
    recordId: v.string(),
    machineId: v.string(),
    contentHash: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_recordKey", ["recordKey"])
    .index("by_updatedAt", ["updatedAt"]),

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
    eventCount: v.number(),
    toolCallCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_project_provider", ["canonicalProjectIdentityKey", "provider", "updatedAt"])
    .index("by_project_machine", ["canonicalProjectIdentityKey", "machineId", "updatedAt"])
    .index("by_project_agent", ["canonicalProjectIdentityKey", "agentName", "updatedAt"])
    .index("by_project_provider_machine", [
      "canonicalProjectIdentityKey",
      "provider",
      "machineId",
      "updatedAt",
    ])
    .index("by_provider_machine", ["provider", "machineId", "updatedAt"])
    .index("by_provider_agent", ["provider", "agentName", "updatedAt"])
    .index("by_machine", ["machineId", "updatedAt"])
    .index("by_agent", ["agentName", "updatedAt"])
    .index("by_provider", ["provider", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

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
    toolCallId: v.optional(v.string()),
    parentEventId: v.optional(v.string()),
    rawReference,
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_eventId", ["eventId"])
    .index("by_session_sequence", ["sessionId", "sequence"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_kind", ["kind", "updatedAt"])
    .index("by_role", ["role", "updatedAt"]),

  contentBlocks: defineTable({
    blockId: v.string(),
    eventId: v.string(),
    sessionId: v.string(),
    sequence: v.number(),
    machineId: v.string(),
    provider,
    agentName: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    kind: contentBlockKind,
    text: v.optional(v.string()),
    markdown: v.optional(v.string()),
    thinking: v.optional(v.string()),
    path: v.optional(v.string()),
    uri: v.optional(v.string()),
    mediaType: v.optional(v.string()),
    value: v.optional(v.any()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_blockId", ["blockId"])
    .index("by_eventId", ["eventId"])
    .index("by_session_sequence", ["sessionId", "sequence"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"]),

  sessionEdges: defineTable({
    edgeId: v.string(),
    sessionId: v.string(),
    machineId: v.string(),
    provider,
    agentName: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    kind: sessionEdgeKind,
    fromEventId: v.optional(v.string()),
    toEventId: v.optional(v.string()),
    fromId: v.optional(v.string()),
    toId: v.optional(v.string()),
    rawReference: v.optional(v.any()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_edgeId", ["edgeId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_kind", ["kind", "updatedAt"]),

  usageRecords: defineTable({
    usageId: v.string(),
    sessionId: v.string(),
    eventId: v.optional(v.string()),
    machineId: v.string(),
    provider,
    agentName: v.string(),
    projectIdentityKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    timestamp: v.optional(v.string()),
    model: v.optional(v.string()),
    modelProvider: v.optional(v.string()),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    cacheCreationInputTokens: v.optional(v.number()),
    cacheReadInputTokens: v.optional(v.number()),
    totalTokens: v.optional(v.number()),
    cost: v.optional(v.number()),
    currency: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_usageId", ["usageId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_eventId", ["eventId"]),

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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_toolCallId", ["toolCallId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_toolName", ["toolName", "updatedAt"])
    .index("by_provider", ["provider", "updatedAt"])
    .index("by_provider_machine", ["provider", "machineId", "updatedAt"])
    .index("by_machine", ["machineId", "updatedAt"])
    .index("by_agent", ["agentName", "updatedAt"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_project_provider", ["canonicalProjectIdentityKey", "provider", "updatedAt"])
    .index("by_project_machine", ["canonicalProjectIdentityKey", "machineId", "updatedAt"])
    .index("by_project_agent", ["canonicalProjectIdentityKey", "agentName", "updatedAt"])
    .index("by_project_tool", ["canonicalProjectIdentityKey", "toolName", "updatedAt"])
    .index("by_project_provider_tool", [
      "canonicalProjectIdentityKey",
      "provider",
      "toolName",
      "updatedAt",
    ])
    .index("by_provider_tool", ["provider", "toolName", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  artifacts: defineTable({
    artifactId: v.string(),
    sessionId: v.string(),
    eventId: v.optional(v.string()),
    machineId: v.string(),
    provider,
    agentName: v.optional(v.string()),
    projectIdentityKey: v.optional(v.string()),
    canonicalProjectIdentityKey: v.optional(v.string()),
    kind: v.string(),
    path: v.optional(v.string()),
    uri: v.optional(v.string()),
    contentHash: v.optional(v.string()),
    sourcePath: v.optional(v.string()),
    sourceRef: v.optional(v.any()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_artifactId", ["artifactId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"]),

  embeddingScopes: defineTable({
    embeddingScopeId: v.string(),
    canonicalProjectIdentityKey: v.string(),
    salt: v.string(),
    policyVersion: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_embeddingScopeId", ["embeddingScopeId"])
    .index("by_canonicalProjectIdentityKey", ["canonicalProjectIdentityKey"]),

  embeddingOutbox: defineTable({
    outboxKey: v.string(),
    searchDocumentId: v.string(),
    searchDocumentRowId: v.id("searchDocuments"),
    expectedContentHash: v.string(),
    embeddingScopeId: v.string(),
    embeddingCacheKey: v.string(),
    status: embeddingOutboxStatus,
    attempts: v.number(),
    maxAttempts: v.optional(v.number()),
    nextAttemptAt: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_outboxKey", ["outboxKey"])
    .index("by_status_nextAttempt", ["status", "nextAttemptAt"])
    .index("by_status_lease", ["status", "leaseExpiresAt"])
    .index("by_searchDocumentId", ["searchDocumentId"]),

  embeddingControls: defineTable({
    controlKey: v.string(),
    paused: v.boolean(),
    activeDrainToken: v.optional(v.string()),
    activeDrainLeaseExpiresAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_controlKey", ["controlKey"]),

  embeddingCache: defineTable({
    embeddingCacheKey: v.string(),
    embeddingScopeId: v.string(),
    modelId: v.string(),
    dimensions: v.number(),
    policyVersion: v.string(),
    chunkerVersion: v.string(),
    normalizedChunkHash: v.string(),
    chunks: v.array(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_embeddingCacheKey", ["embeddingCacheKey"])
    .index("by_scope", ["embeddingScopeId", "updatedAt"]),

  embeddingReadiness: defineTable({
    aggregateKey: v.string(),
    canonicalProjectIdentityKey: v.string(),
    machineId: v.optional(v.string()),
    provider: v.optional(provider),
    agentName: v.optional(v.string()),
    role: v.optional(role),
    kind: v.optional(eventKind),
    toolName: v.optional(v.string()),
    family: searchFamily,
    ragSyncState,
    documentCount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_aggregateKey", ["aggregateKey"])
    .index("by_project", ["canonicalProjectIdentityKey"])
    .index("by_provider", ["provider"])
    .index("by_family", ["family"])
    .index("by_state", ["ragSyncState"]),

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
    lexicalText: v.optional(v.string()),
    embeddingText: v.optional(v.string()),
    embeddingTextHash: v.optional(v.string()),
    embeddingEligible: v.optional(v.boolean()),
    embeddingSkipReason: v.optional(v.string()),
    embeddingScopeId: v.optional(v.string()),
    embeddingPolicyVersion: v.optional(v.string()),
    embeddingCacheKey: v.optional(v.string()),
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
    .index("by_occurredAt", ["occurredAt"])
    .index("by_project_occurredAt", ["canonicalProjectIdentityKey", "occurredAt"])
    .index("by_ragSyncState", ["ragSyncState", "updatedAt"])
    .index("by_project_ragSyncState", ["canonicalProjectIdentityKey", "ragSyncState", "updatedAt"])
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
