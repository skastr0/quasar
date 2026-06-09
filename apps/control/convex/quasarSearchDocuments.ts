import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { updateEmbeddingReadinessAggregates } from "./quasarEmbeddingReadiness";
import { serverEmbeddingsConfigured } from "./quasarRag";
import type {
  SearchArgs,
  SearchDocument,
  SearchDocumentInsert,
  SearchDocumentUpsertInput,
} from "./quasarSearchTypes";
import {
  compactText,
  hashText,
  MAX_EMBEDDING_TEXT_BYTES,
  MAX_SEARCH_TEXT_LENGTH,
  MAX_SUMMARY_LENGTH,
  truncate,
  wideHash,
} from "./quasarText";
import {
  canonicalFilter,
  kindFilter,
  machineFilter,
  parseDateBound,
  providerFilter,
} from "./quasarValues";

export const searchDocumentRagContentHash = (doc: {
  readonly title: string;
  readonly searchText: string;
  readonly canonicalProjectIdentityKey: string;
  readonly machineId: string;
  readonly provider?: string;
  readonly kind?: string;
  readonly toolName?: string;
}) =>
  `wide:${wideHash(
    [
      "quasar-rag/v1",
      doc.title,
      doc.searchText,
      doc.canonicalProjectIdentityKey,
      doc.machineId,
      doc.provider ?? "",
      doc.kind ?? "",
      doc.toolName ?? "",
    ].join("\u001f"),
  )}`;

export const EMBEDDING_POLICY_VERSION = "quasar-narrative-v1";
export const EMBEDDING_CHUNKER_VERSION = "convex-rag-default-v1";

export const scheduleSearchDocumentRagSync = async (
  ctx: MutationCtx,
  searchDocumentId: Id<"searchDocuments">,
  expectedContentHash: string,
) => {
  if (!serverEmbeddingsConfigured()) return;
  const state = ctx as MutationCtx & { __quasarRagSchedules?: number };
  state.__quasarRagSchedules = state.__quasarRagSchedules ?? 0;
  if (state.__quasarRagSchedules >= 900) return;
  state.__quasarRagSchedules += 1;
  await ctx.scheduler.runAfter(5 * 60_000, internal.quasar.syncSearchDocumentRagInternal, {
    searchDocumentId,
    expectedContentHash,
  });
};

export const upsertSearchDocument = async (
  ctx: MutationCtx,
  input: SearchDocumentUpsertInput,
) => {
  const now = Date.now();
  const searchText = truncate(input.lexicalText ?? input.searchText, MAX_SEARCH_TEXT_LENGTH);
  const existing = await findSearchDocument(ctx, input.searchDocumentId);
  const eligibility = embeddingEligibility(input, searchText);
  const scope = eligibility.eligible
    ? await ensureEmbeddingScope(ctx, input.canonicalProjectIdentityKey, now)
    : undefined;
  const embeddingText =
    eligibility.eligible && searchText.trim().length > 0
      ? truncate(input.embeddingText ?? searchText, MAX_EMBEDDING_TEXT_BYTES)
      : undefined;
  const ragContentHash =
    eligibility.eligible && embeddingText !== undefined
      ? searchDocumentRagContentHash({ ...input, searchText: embeddingText })
      : undefined;
  const embeddingCacheKey =
    scope !== undefined && ragContentHash !== undefined
      ? await embeddingCacheKeyFor({
          embeddingScopeId: scope.embeddingScopeId,
          salt: scope.salt,
          modelId: "gemini-embedding-2",
          dimensions: 1536,
          policyVersion: EMBEDDING_POLICY_VERSION,
          chunkerVersion: EMBEDDING_CHUNKER_VERSION,
          normalizedChunkHash: ragContentHash,
        })
      : undefined;
  const patch = searchDocumentPatch({
    input,
    existing,
    searchText,
    embeddingText,
    eligibility,
    scope,
    ragContentHash,
    embeddingCacheKey,
    now,
  });

  if (existing === null) {
    const id = await ctx.db.insert("searchDocuments", { ...patch, createdAt: now });
    await updateEmbeddingReadinessAggregates(ctx, null, patch as SearchDocument);
    await enqueueEmbeddingIfNeeded(ctx, id, patch);
    return id;
  }

  const changed =
    existing.searchTextHash !== patch.searchTextHash ||
    existing.ragContentHash !== ragContentHash ||
    existing.embeddingCacheKey !== embeddingCacheKey;
  await ctx.db.patch(existing._id, patch);
  await updateEmbeddingReadinessAggregates(ctx, existing, {
    ...existing,
    ...patch,
  });
  if (changed || patch.ragSyncState === "pending") await enqueueEmbeddingIfNeeded(ctx, existing._id, patch);
  return existing._id;
};

export const requeueSearchDocumentEmbedding = async (
  ctx: MutationCtx,
  doc: SearchDocument,
) => {
  const now = Date.now();
  const searchText = truncate(doc.lexicalText ?? doc.searchText, MAX_SEARCH_TEXT_LENGTH);
  const eligibility = embeddingEligibility(doc, searchText);
  const scope = eligibility.eligible
    ? await ensureEmbeddingScope(ctx, doc.canonicalProjectIdentityKey, now)
    : undefined;
  const embeddingText =
    eligibility.eligible && searchText.trim().length > 0
      ? truncate(doc.embeddingText ?? searchText, MAX_EMBEDDING_TEXT_BYTES)
      : undefined;
  const ragContentHash =
    eligibility.eligible && embeddingText !== undefined
      ? searchDocumentRagContentHash({ ...doc, searchText: embeddingText })
      : undefined;
  const embeddingCacheKey =
    scope !== undefined && ragContentHash !== undefined
      ? await embeddingCacheKeyFor({
          embeddingScopeId: scope.embeddingScopeId,
          salt: scope.salt,
          modelId: "gemini-embedding-2",
          dimensions: 1536,
          policyVersion: EMBEDDING_POLICY_VERSION,
          chunkerVersion: EMBEDDING_CHUNKER_VERSION,
          normalizedChunkHash: ragContentHash,
        })
      : undefined;
  const patch = searchDocumentPatch({
    input: doc,
    existing: doc,
    searchText,
    embeddingText,
    eligibility,
    scope,
    ragContentHash,
    embeddingCacheKey,
    now,
  });
  const next = { ...doc, ...patch };
  await ctx.db.patch(doc._id, patch);
  await updateEmbeddingReadinessAggregates(ctx, doc, next);
  await enqueueEmbeddingIfNeeded(ctx, doc._id, patch);
  return patch.ragSyncState === "pending";
};

const findSearchDocument = async (ctx: MutationCtx, searchDocumentId: string) =>
  await ctx.db
    .query("searchDocuments")
    .withIndex("by_searchDocumentId", (q) => q.eq("searchDocumentId", searchDocumentId))
    .unique();

const searchDocumentPatch = (args: {
  input: SearchDocumentUpsertInput;
  existing: SearchDocument | null;
  searchText: string;
  embeddingText?: string;
  eligibility: EmbeddingEligibility;
  scope?: { embeddingScopeId: string; salt: string };
  ragContentHash?: string;
  embeddingCacheKey?: string;
  now: number;
}): Omit<SearchDocumentInsert, "createdAt"> => {
  const configured = serverEmbeddingsConfigured();
  const preserveReady =
    args.existing?.ragSyncState === "ready" &&
    args.existing.ragContentHash === args.ragContentHash &&
    args.existing.embeddingCacheKey === args.embeddingCacheKey;
  const ragSyncState = !args.eligibility.eligible
    ? "skipped"
    : !configured
      ? "skipped"
      : preserveReady
        ? "ready"
        : "pending";
  return {
    ...args.input,
    summary:
      args.input.summary === undefined
        ? undefined
        : truncate(compactText(args.input.summary), MAX_SUMMARY_LENGTH),
    searchText: args.searchText,
    lexicalText: args.searchText,
    searchTextHash: hashText(args.searchText),
    embeddingText: args.embeddingText,
    embeddingTextHash: args.embeddingText === undefined ? undefined : hashText(args.embeddingText),
    embeddingEligible: args.eligibility.eligible,
    embeddingSkipReason:
      args.eligibility.eligible && configured
        ? undefined
        : args.eligibility.skipReason ?? "embedding_provider_unconfigured",
    embeddingScopeId: args.scope?.embeddingScopeId,
    embeddingPolicyVersion: EMBEDDING_POLICY_VERSION,
    embeddingCacheKey: args.embeddingCacheKey,
    activeProject: canonicalFilter(args.input.canonicalProjectIdentityKey),
    activeMachine: machineFilter(args.input.machineId),
    activeProvider:
      args.input.provider === undefined ? undefined : providerFilter(args.input.provider),
    activeKind: args.input.kind === undefined ? undefined : kindFilter(args.input.kind),
    ragEntryId: preserveReady ? args.existing?.ragEntryId : undefined,
    ragContentHash: args.ragContentHash,
    ragSyncState,
    ragSyncedAt: preserveReady ? args.existing?.ragSyncedAt : undefined,
    ragError: undefined,
    updatedAt: args.now,
  };
};

type EmbeddingEligibility =
  | { readonly eligible: true; readonly skipReason?: undefined }
  | { readonly eligible: false; readonly skipReason: string };

const embeddingEligibility = (
  input: SearchDocumentUpsertInput,
  searchText: string,
): EmbeddingEligibility => {
  if (input.embeddingEligible === false) {
    return { eligible: false, skipReason: input.embeddingSkipReason ?? "policy_default" };
  }
  if (input.embeddingEligible === true) {
    return searchText.trim().length === 0
      ? { eligible: false, skipReason: "empty_text" }
      : { eligible: true };
  }
  if (input.family === "sessionEvents" && input.kind === "message" && input.role === "user") {
    return searchText.trim().length === 0
      ? { eligible: false, skipReason: "empty_text" }
      : { eligible: true };
  }
  if (input.family === "toolCalls" || input.kind === "tool_call" || input.kind === "tool_result") {
    return { eligible: false, skipReason: "tool_metadata_only" };
  }
  if (input.kind === "reasoning" || input.role === "thinking") {
    return { eligible: false, skipReason: "reasoning" };
  }
  if (input.family === "contentBlocks") return { eligible: false, skipReason: "raw_content_block" };
  if (input.family === "artifacts") return { eligible: false, skipReason: "artifact" };
  return { eligible: false, skipReason: input.embeddingSkipReason ?? "policy_default" };
};

const ensureEmbeddingScope = async (
  ctx: MutationCtx,
  canonicalProjectIdentityKey: string,
  now: number,
) => {
  const existing = await ctx.db
    .query("embeddingScopes")
    .withIndex("by_canonicalProjectIdentityKey", (q) =>
      q.eq("canonicalProjectIdentityKey", canonicalProjectIdentityKey),
    )
    .unique();
  if (existing !== null) return existing;
  const salt = randomScopeSalt(canonicalProjectIdentityKey, now);
  const embeddingScopeId = `scope:${wideHash(`${canonicalProjectIdentityKey}\u001f${salt}`)}`;
  await ctx.db.insert("embeddingScopes", {
    embeddingScopeId,
    canonicalProjectIdentityKey,
    salt,
    policyVersion: EMBEDDING_POLICY_VERSION,
    createdAt: now,
    updatedAt: now,
  });
  return { embeddingScopeId, canonicalProjectIdentityKey, salt, policyVersion: EMBEDDING_POLICY_VERSION };
};

const embeddingCacheKeyFor = async (args: {
  readonly embeddingScopeId: string;
  readonly salt: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly policyVersion: string;
  readonly chunkerVersion: string;
  readonly normalizedChunkHash: string;
}) => {
  const payload = [
    "quasar-embedding-cache-key/v1",
    args.embeddingScopeId,
    args.modelId,
    String(args.dimensions),
    args.policyVersion,
    args.chunkerVersion,
    args.normalizedChunkHash,
  ].join("\u001f");
  return `emb:${await hmacSha256Hex(args.salt, payload)}`;
};

const randomScopeSalt = (canonicalProjectIdentityKey: string, now: number) => {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : wideHash(`${canonicalProjectIdentityKey}\u001f${now}\u001f${Date.now()}`);
  return `salt:${randomUuid}`;
};

const hmacSha256Hex = async (secret: string, payload: string) => {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.subtle === undefined) {
    return wideHash(`${secret}\u001f${payload}`);
  }
  const encoder = new TextEncoder();
  const key = await cryptoApi.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await cryptoApi.subtle.sign("HMAC", key, encoder.encode(payload));
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

const enqueueEmbeddingIfNeeded = async (
  ctx: MutationCtx,
  searchDocumentRowId: Id<"searchDocuments">,
  patch: Omit<SearchDocumentInsert, "createdAt">,
) => {
  if (
    patch.ragSyncState !== "pending" ||
    patch.ragContentHash === undefined ||
    patch.embeddingScopeId === undefined ||
    patch.embeddingCacheKey === undefined
  ) {
    return;
  }
  const now = Date.now();
  const outboxKey = `${patch.searchDocumentId}:${patch.ragContentHash}`;
  const existing = await ctx.db
    .query("embeddingOutbox")
    .withIndex("by_outboxKey", (q) => q.eq("outboxKey", outboxKey))
    .unique();
  const outboxPatch = {
    searchDocumentId: patch.searchDocumentId,
    searchDocumentRowId,
    expectedContentHash: patch.ragContentHash,
    embeddingScopeId: patch.embeddingScopeId,
    embeddingCacheKey: patch.embeddingCacheKey,
    status: "pending" as const,
    maxAttempts: 6,
    nextAttemptAt: now,
    leaseExpiresAt: undefined,
    leaseToken: undefined,
    lastError: undefined,
    updatedAt: now,
  };
  if (existing === null) {
    await ctx.db.insert("embeddingOutbox", {
      outboxKey,
      ...outboxPatch,
      attempts: 0,
      createdAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { ...outboxPatch, attempts: 0 });
  }
  await scheduleEmbeddingOutboxDrain(ctx);
};

const scheduleEmbeddingOutboxDrain = async (ctx: MutationCtx) => {
  if (!serverEmbeddingsConfigured()) return;
  const state = ctx as MutationCtx & { __quasarEmbeddingDrainScheduled?: boolean };
  if (state.__quasarEmbeddingDrainScheduled === true) return;
  state.__quasarEmbeddingDrainScheduled = true;
  await ctx.scheduler.runAfter(30_000, internal.quasar.drainEmbeddingOutboxInternal, {
    limit: 20,
  });
};

export const deleteSearchDocumentById = async (
  ctx: MutationCtx,
  searchDocumentId: string,
) => {
  const doc = await findSearchDocument(ctx, searchDocumentId);
  if (doc !== null) {
    await updateEmbeddingReadinessAggregates(ctx, doc, null);
    await ctx.db.delete(doc._id);
  }
};

export const matchesFilters = (doc: SearchDocument, args: SearchArgs) => {
  const from = parseDateBound(args.from, "from");
  const to = parseDateBound(args.to, "to");
  return (
    matchesProject(doc, args.projectIdentityKey) &&
    (args.machineId === undefined || doc.machineId === args.machineId) &&
    (args.provider === undefined || doc.provider === args.provider) &&
    (args.agentName === undefined || doc.agentName === args.agentName) &&
    (args.role === undefined || doc.role === args.role) &&
    (args.kind === undefined || doc.kind === args.kind) &&
    (args.toolName === undefined || doc.toolName === args.toolName) &&
    (from === undefined || (doc.occurredAt !== undefined && doc.occurredAt >= from)) &&
    (to === undefined || (doc.occurredAt !== undefined && doc.occurredAt <= to))
  );
};

const matchesProject = (doc: SearchDocument, projectIdentityKey: string | undefined) =>
  projectIdentityKey === undefined ||
  doc.canonicalProjectIdentityKey === projectIdentityKey ||
  doc.projectIdentityKey === projectIdentityKey;

export const baseMatch = (doc: SearchDocument, score: number) => ({
  searchDocumentId: doc.searchDocumentId,
  sourceTable: doc.sourceTable,
  sourceId: doc.sourceId,
  family: doc.family,
  title: doc.title,
  summary: doc.summary,
  projectIdentityKey: doc.canonicalProjectIdentityKey,
  machineId: doc.machineId,
  provider: doc.provider,
  agentName: doc.agentName,
  role: doc.role,
  kind: doc.kind,
  toolName: doc.toolName,
  occurredAt: doc.occurredAt,
  sourcePath: doc.sourcePath,
  sourceRef: doc.sourceRef,
  score,
});
