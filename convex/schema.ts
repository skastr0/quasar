import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    projectKey: v.string(),
    displayName: v.string(),
    aliases: v.array(v.string()),
    rawPaths: v.array(v.string()),
  }).index("by_projectKey", ["projectKey"]),

  sessions: defineTable({
    sessionId: v.string(),
    projectKey: v.string(),
    provider: v.string(),
    agentName: v.string(),
    title: v.optional(v.string()),
    startedAt: v.optional(v.string()),
    updatedAt: v.optional(v.string()),
    sourcePath: v.string(),
    sourceFingerprint: v.string(),
    messageCount: v.number(),
    toolCallCount: v.number(),
    // In-progress ingest claim: set by beginSessionIngest, cleared by
    // commitSessionIngest once every turn row has landed. A session is only
    // complete (and skippable on an unchanged fingerprint) when this is unset.
    ingestRunId: v.optional(v.string()),
    // Search indexing lock: set immediately before LanceDB mutation and
    // cleared by commit/abort so concurrent reclaims cannot race stale rows.
    indexingRunId: v.optional(v.string()),
    indexingStartedAt: v.optional(v.number()),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_projectKey", ["projectKey"])
    .index("by_projectKey_and_provider", ["projectKey", "provider"]),

  messages: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    role: v.union(
      v.literal("user"),
      v.literal("assistant"),
      v.literal("reasoning"),
    ),
    text: v.string(),
    ts: v.optional(v.string()),
    projectKey: v.string(),
  })
    .index("by_sessionId_and_seq", ["sessionId", "seq"])
    .index("by_sessionId_and_role_and_seq", ["sessionId", "role", "seq"]),

  // Structural surface: full tool inputs/outputs, retrieved by exact index walks.
  // NEVER search-indexed, NEVER embedded — tool payloads must not pollute search.
  toolCalls: defineTable({
    sessionId: v.string(),
    seq: v.number(),
    toolName: v.string(),
    status: v.optional(v.string()),
    inputText: v.string(),
    outputText: v.string(),
    startedAt: v.optional(v.string()),
    completedAt: v.optional(v.string()),
    projectKey: v.string(),
    provider: v.string(),
  })
    .index("by_sessionId_and_seq", ["sessionId", "seq"])
    .index("by_projectKey_and_toolName", ["projectKey", "toolName"])
    .index("by_projectKey_and_provider", ["projectKey", "provider"])
    .index("by_projectKey_and_provider_and_toolName", ["projectKey", "provider", "toolName"]),
});
