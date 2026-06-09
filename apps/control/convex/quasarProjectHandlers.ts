import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type {
  MachineIdentityBoundary,
  ProjectResolutionBoundary,
  ProviderSchema,
} from "./quasarDomainSchemas";
import { updateEmbeddingReadinessAggregates } from "./quasarEmbeddingReadiness";
import { upsertSearchDocument } from "./quasarSearchDocuments";
import { compactSearchText } from "./quasarText";
import { canonicalFilter } from "./quasarValues";

export const ensureMachine = async (
  ctx: MutationCtx,
  machine: MachineIdentityBoundary,
) => {
  const now = Date.now();
  const machineId = machine.machineId;
  const existing = await ctx.db
    .query("machines")
    .withIndex("by_machineId", (q) => q.eq("machineId", machineId))
    .unique();
  const patch = {
    machineId,
    hostname: stringValue(machine.hostname),
    tailscaleName: stringValue(machine.tailscaleName),
    platform: stringValue(machine.platform),
    updatedAt: now,
  };
  if (existing === null) await ctx.db.insert("machines", { ...patch, createdAt: now });
  else if (!patchMatches(existing, patch, ["updatedAt"])) await ctx.db.patch(existing._id, patch);
};

export const ensureAgent = async (
  ctx: MutationCtx,
  providerValue: ProviderSchema,
  agentName: string,
) => {
  const now = Date.now();
  const existing = await ctx.db
    .query("agentDefinitions")
    .withIndex("by_provider_and_agentName", (q) =>
      q.eq("provider", providerValue).eq("agentName", agentName),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("agentDefinitions", {
      provider: providerValue,
      agentName,
      displayName: agentName,
      createdAt: now,
      updatedAt: now,
    });
  }
};

export const upsertProjectIdentity = async (
  ctx: MutationCtx,
  project: ProjectResolutionBoundary,
) => {
  const now = Date.now();
  const key = String(project.projectIdentityKey ?? "");
  const existing = await findProjectIdentity(ctx, key);
  const canonicalProjectIdentityKey = existing?.canonicalProjectIdentityKey ?? key;
  const patch = projectIdentityPatch(project, key, canonicalProjectIdentityKey, now);
  if (existing === null) {
    await ctx.db.insert("projectIdentities", { ...patch, createdAt: now });
    await upsertProjectSearchDocument(ctx, project, patch, key, canonicalProjectIdentityKey, now);
  } else if (!patchMatches(existing, patch, ["updatedAt"])) {
    await ctx.db.patch(existing._id, patch);
    await upsertProjectSearchDocument(ctx, project, patch, key, canonicalProjectIdentityKey, now);
  }
  return canonicalProjectIdentityKey;
};

const findProjectIdentity = async (ctx: MutationCtx, key: string) =>
  await ctx.db
    .query("projectIdentities")
    .withIndex("by_projectIdentityKey", (q) => q.eq("projectIdentityKey", key))
    .unique();

const projectIdentityPatch = (
  project: ProjectResolutionBoundary,
  key: string,
  canonicalProjectIdentityKey: string,
  now: number,
) => ({
  projectIdentityKey: key,
  canonicalProjectIdentityKey,
  displayName: String(project.displayName ?? key),
  confidence: project.confidence,
  rawPath: stringValue(project.rawPath),
  normalizedPath: stringValue(project.normalizedPath),
  gitRemote: stringValue(project.gitRemote),
  gitRemoteNormalized: stringValue(project.gitRemoteNormalized),
  packageName: stringValue(project.packageName),
  signals: [...project.signals],
  updatedAt: now,
});

const upsertProjectSearchDocument = async (
  ctx: MutationCtx,
  project: ProjectResolutionBoundary,
  patch: ReturnType<typeof projectIdentityPatch>,
  key: string,
  canonicalProjectIdentityKey: string,
  now: number,
) =>
  await upsertSearchDocument(ctx, {
    searchDocumentId: `project:${key}`,
    sourceTable: "projectIdentities",
    sourceId: key,
    family: "projectIdentities",
    projectIdentityKey: key,
    canonicalProjectIdentityKey,
    machineId: "project-registry",
    title: patch.displayName,
    summary: patch.normalizedPath ?? patch.gitRemoteNormalized,
    searchText: compactSearchText(project),
    searchTextHash: "",
    sourceRef: { projectIdentityKey: key },
    occurredAt: now,
    activeProject: "",
    activeMachine: "",
    sourceUpdatedAt: now,
  });

export const aliasProjectHandler = async (
  ctx: MutationCtx,
  args: {
    sourceProjectIdentityKey: string;
    targetProjectIdentityKey: string;
    reason?: string;
  },
) => {
  const now = Date.now();
  const { source, targetCanonical } = await loadAliasProjects(ctx, args);
  await ctx.db.patch(source._id, {
    canonicalProjectIdentityKey: targetCanonical,
    updatedAt: now,
  });
  await upsertProjectAlias(ctx, args, targetCanonical, now);
  await repointGraphRows(ctx, args.sourceProjectIdentityKey, targetCanonical);
  await repointSearchRows(ctx, args.sourceProjectIdentityKey, targetCanonical, now);
  return {
    sourceProjectIdentityKey: args.sourceProjectIdentityKey,
    targetProjectIdentityKey: targetCanonical,
  };
};

const loadAliasProjects = async (
  ctx: MutationCtx,
  args: { sourceProjectIdentityKey: string; targetProjectIdentityKey: string },
) => {
  const target = await findProjectIdentity(ctx, args.targetProjectIdentityKey);
  if (target === null) throw new Error("Target project identity was not found.");
  const source = await findProjectIdentity(ctx, args.sourceProjectIdentityKey);
  if (source === null) throw new Error("Source project identity was not found.");
  return { source, targetCanonical: target.canonicalProjectIdentityKey };
};

const upsertProjectAlias = async (
  ctx: MutationCtx,
  args: { sourceProjectIdentityKey: string; reason?: string },
  targetCanonical: string,
  now: number,
) => {
  const existing = await ctx.db
    .query("projectAliases")
    .withIndex("by_sourceProjectIdentityKey", (q) =>
      q.eq("sourceProjectIdentityKey", args.sourceProjectIdentityKey),
    )
    .unique();
  const patch = { targetProjectIdentityKey: targetCanonical, reason: args.reason, updatedAt: now };
  if (existing === null) {
    await ctx.db.insert("projectAliases", {
      sourceProjectIdentityKey: args.sourceProjectIdentityKey,
      ...patch,
      createdAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, patch);
  }
};

const repointGraphRows = async (
  ctx: MutationCtx,
  sourceProjectIdentityKey: string,
  targetCanonical: string,
) => {
  for (const tableName of ["sessions", "sessionEvents", "toolCalls"] as const) {
    for (const key of [sourceProjectIdentityKey, targetCanonical]) {
      const rows = await ctx.db
        .query(tableName)
        .withIndex("by_project", (q) => q.eq("canonicalProjectIdentityKey", key))
        .take(PROJECT_ALIAS_REPOINT_LIMIT);
      for (const row of rows) {
        if (rowMatchesProject(row, sourceProjectIdentityKey)) {
          await ctx.db.patch(row._id, { canonicalProjectIdentityKey: targetCanonical });
        }
      }
    }
  }
};

const repointSearchRows = async (
  ctx: MutationCtx,
  sourceProjectIdentityKey: string,
  targetCanonical: string,
  now: number,
) => {
  for (const key of [sourceProjectIdentityKey, targetCanonical]) {
    const rows = await ctx.db
      .query("searchDocuments")
      .withIndex("by_project", (q) => q.eq("canonicalProjectIdentityKey", key))
      .take(PROJECT_ALIAS_REPOINT_LIMIT);
    for (const row of rows) {
      if (!rowMatchesProject(row, sourceProjectIdentityKey)) continue;
      const patch = {
        canonicalProjectIdentityKey: targetCanonical,
        activeProject: canonicalFilter(targetCanonical),
        ragEntryId: undefined,
        ragContentHash: undefined,
        ragSyncState: "skipped",
        ragSyncedAt: undefined,
        embeddingScopeId: undefined,
        embeddingCacheKey: undefined,
        embeddingSkipReason: "project_alias_rebuild_required",
        updatedAt: now,
      } as const;
      const next = { ...row, ...patch };
      await ctx.db.patch(row._id, patch);
      await updateEmbeddingReadinessAggregates(ctx, row, next);
    }
  }
};

const rowMatchesProject = (
  row: Pick<Doc<"sessions"> | Doc<"sessionEvents"> | Doc<"toolCalls"> | Doc<"searchDocuments">, "projectIdentityKey" | "canonicalProjectIdentityKey">,
  sourceProjectIdentityKey: string,
) =>
  row.projectIdentityKey === sourceProjectIdentityKey ||
  row.canonicalProjectIdentityKey === sourceProjectIdentityKey;

export const listProjectsHandler = async (
  ctx: QueryCtx,
  args: { cursor?: string | null; limit?: number } = {},
) => {
  const limit = Math.min(100, Math.max(1, Math.trunc(args.limit ?? 50)));
  const projects = await ctx.db
    .query("projectIdentities")
    .withIndex("by_updatedAt")
    .order("desc")
    .paginate({ cursor: args.cursor ?? null, numItems: limit });
  const rows = [];
  for (const project of projects.page) {
    const sessions = await ctx.db
      .query("sessions")
      .withIndex("by_project", (q) =>
        q.eq("canonicalProjectIdentityKey", project.canonicalProjectIdentityKey),
      )
      .take(1000);
    rows.push({
      projectIdentityKey: project.projectIdentityKey,
      canonicalProjectIdentityKey: project.canonicalProjectIdentityKey,
      displayName: project.displayName,
      confidence: project.confidence,
      rawPath: project.rawPath,
      gitRemoteNormalized: project.gitRemoteNormalized,
      sessionCount: sessions.length,
      sessionCountTruncated: sessions.length >= 1000,
      updatedAt: project.updatedAt,
    });
  }
  return {
    items: rows.sort(
      (left, right) =>
        right.sessionCount - left.sessionCount || right.updatedAt - left.updatedAt,
    ),
    isDone: projects.isDone,
    continueCursor: projects.continueCursor,
  };
};

const stringValue = (value: unknown) =>
  typeof value === "string" ? value : undefined;

const patchMatches = (
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
  ignoredKeys: readonly string[] = [],
) =>
  Object.entries(patch).every(([key, value]) =>
    ignoredKeys.includes(key) ? true : valueMatches(existing[key], value),
  );

const valueMatches = (left: unknown, right: unknown) =>
  Array.isArray(left) || Array.isArray(right)
    ? JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
    : left === right;

const PROJECT_ALIAS_REPOINT_LIMIT = 500;
