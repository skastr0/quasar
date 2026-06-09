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

const ragSyncState = v.union(
  v.literal("pending"),
  v.literal("syncing"),
  v.literal("ready"),
  v.literal("skipped"),
  v.literal("failed"),
  v.literal("dead_letter"),
);

const importJobStatus = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial_failure"),
  v.literal("failed"),
);

const importChunkStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("dead_letter"),
);

const sessionIngestState = v.union(
  v.literal("partial"),
  v.literal("complete"),
  v.literal("failed"),
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
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
    ingestState: v.optional(sessionIngestState),
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
    content: v.optional(v.any()),
    contentBlocks: v.optional(v.array(v.any())),
    toolCallId: v.optional(v.string()),
    parentEventId: v.optional(v.string()),
    rawReference: v.any(),
    raw: v.optional(v.any()),
    importRunId: v.string(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
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
    importRunId: v.string(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
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
    importRunId: v.string(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
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
    raw: v.optional(v.any()),
    importRunId: v.string(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
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
    raw: v.optional(v.any()),
    importRunId: v.string(),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
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
    raw: v.optional(v.any()),
    importRunId: v.optional(v.string()),
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_artifactId", ["artifactId"])
    .index("by_sessionId", ["sessionId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"]),

  importRuns: defineTable({
    importRunId: v.string(),
    machineId: v.string(),
    status: v.union(v.literal("succeeded"), v.literal("partial_failure"), v.literal("failed")),
    sourceRootCount: v.number(),
    sessionCount: v.number(),
    eventCount: v.number(),
    toolCallCount: v.number(),
    contentBlockCount: v.optional(v.number()),
    sessionEdgeCount: v.optional(v.number()),
    usageRecordCount: v.optional(v.number()),
    artifactCount: v.optional(v.number()),
    diagnostics: v.array(v.any()),
    error: v.optional(v.string()),
    importJobId: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_importRunId", ["importRunId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_machineId", ["machineId"]),

  importJobs: defineTable({
    importJobId: v.string(),
    idempotencyKey: v.string(),
    machineId: v.string(),
    status: importJobStatus,
    generatedAt: v.optional(v.string()),
    sourceRootCount: v.number(),
    sessionCount: v.number(),
    eventCount: v.number(),
    toolCallCount: v.number(),
    contentBlockCount: v.optional(v.number()),
    sessionEdgeCount: v.optional(v.number()),
    usageRecordCount: v.optional(v.number()),
    artifactCount: v.optional(v.number()),
    chunkCount: v.number(),
    expectedChunkCount: v.optional(v.number()),
    uploadedChunkCount: v.optional(v.number()),
    succeededChunkCount: v.number(),
    failedChunkCount: v.number(),
    terminalChunkSequenceSum: v.optional(v.number()),
    diagnostics: v.array(v.any()),
    error: v.optional(v.string()),
    workerLeaseExpiresAt: v.optional(v.number()),
    workerLeaseToken: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_importJobId", ["importJobId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_status", ["status", "updatedAt"])
    .index("by_createdAt", ["createdAt"]),

  importShards: defineTable({
    shardId: v.string(),
    importJobId: v.string(),
    provider,
    machineId: v.string(),
    status: importJobStatus,
    sessionCount: v.number(),
    eventCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_shardId", ["shardId"])
    .index("by_importJobId", ["importJobId"])
    .index("by_job_provider", ["importJobId", "provider"]),

  importChunks: defineTable({
    chunkId: v.string(),
    importJobId: v.string(),
    idempotencyKey: v.string(),
    sequence: v.number(),
    status: importChunkStatus,
    sessionCount: v.number(),
    eventCount: v.number(),
    toolCallCount: v.number(),
    contentBlockCount: v.optional(v.number()),
    sessionEdgeCount: v.optional(v.number()),
    usageRecordCount: v.optional(v.number()),
    artifactCount: v.optional(v.number()),
    attempts: v.number(),
    maxAttempts: v.optional(v.number()),
    batch: v.optional(v.any()),
    payloadHash: v.optional(v.string()),
    payloadBytes: v.optional(v.number()),
    error: v.optional(v.string()),
    nextAttemptAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    leaseToken: v.optional(v.string()),
    payloadStoredAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chunkId", ["chunkId"])
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_job_sequence", ["importJobId", "sequence"])
    .index("by_importJobId", ["importJobId"])
    .index("by_job_status", ["importJobId", "status"])
    .index("by_job_status_nextAttempt", ["importJobId", "status", "nextAttemptAt"])
    .index("by_job_status_lease", ["importJobId", "status", "leaseExpiresAt"])
    .index("by_status_nextAttempt", ["status", "nextAttemptAt"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),

  importChunkPayloads: defineTable({
    chunkId: v.string(),
    importJobId: v.string(),
    payloadHash: v.string(),
    payloadBytes: v.number(),
    batch: v.any(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chunkId", ["chunkId"])
    .index("by_importJobId", ["importJobId"]),

  importWorkerLeases: defineTable({
    importJobId: v.string(),
    leaseToken: v.string(),
    leaseExpiresAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_importJobId", ["importJobId"])
    .index("by_leaseExpiresAt", ["leaseExpiresAt"]),

  importCheckpoints: defineTable({
    checkpointId: v.string(),
    importJobId: v.string(),
    chunkId: v.string(),
    provider,
    machineId: v.string(),
    sessionId: v.optional(v.string()),
    nativeRowId: v.optional(v.string()),
    sequence: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_checkpointId", ["checkpointId"])
    .index("by_importJobId", ["importJobId"])
    .index("by_chunkId", ["chunkId"]),

  importFailures: defineTable({
    failureId: v.string(),
    importJobId: v.string(),
    chunkId: v.optional(v.string()),
    provider: v.optional(provider),
    machineId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    error: v.string(),
    retryable: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_failureId", ["failureId"])
    .index("by_importJobId", ["importJobId"])
    .index("by_chunkId", ["chunkId"]),

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
    importJobId: v.optional(v.string()),
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
    .index("by_job", ["importJobId"])
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
    importJobId: v.optional(v.string()),
    importChunkId: v.optional(v.string()),
    sourceUpdatedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_searchDocumentId", ["searchDocumentId"])
    .index("by_sourceTable_and_sourceId", ["sourceTable", "sourceId"])
    .index("by_project", ["canonicalProjectIdentityKey", "updatedAt"])
    .index("by_occurredAt", ["occurredAt"])
    .index("by_project_occurredAt", ["canonicalProjectIdentityKey", "occurredAt"])
    .index("by_importJobId", ["importJobId", "updatedAt"])
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
