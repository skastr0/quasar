import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { serverEmbeddingsConfigured } from "./quasarRag";
import {
  scheduleSearchDocumentRagSync,
  searchDocumentRagContentHash,
  upsertSearchDocument,
} from "./quasarSearchDocuments";
import { compactSearchText } from "./quasarText";
import { canonicalFilter } from "./quasarValues";

export const ensureMachine = async (
  ctx: MutationCtx,
  machine: Record<string, unknown>,
) => {
  const now = Date.now();
  const machineId = String(machine.machineId ?? "");
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
  else await ctx.db.patch(existing._id, patch);
};

export const ensureAgent = async (
  ctx: MutationCtx,
  providerValue: string,
  agentName: string,
) => {
  const now = Date.now();
  const existing = await ctx.db
    .query("agentDefinitions")
    .withIndex("by_provider_and_agentName", (q) =>
      q.eq("provider", providerValue as never).eq("agentName", agentName),
    )
    .unique();
  if (existing === null) {
    await ctx.db.insert("agentDefinitions", {
      provider: providerValue as never,
      agentName,
      displayName: agentName,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(existing._id, { updatedAt: now });
  }
};

export const upsertProjectIdentity = async (
  ctx: MutationCtx,
  project: Record<string, unknown>,
) => {
  const now = Date.now();
  const key = String(project.projectIdentityKey ?? "");
  const existing = await findProjectIdentity(ctx, key);
  const canonicalProjectIdentityKey = existing?.canonicalProjectIdentityKey ?? key;
  const patch = projectIdentityPatch(project, key, canonicalProjectIdentityKey, now);
  if (existing === null) await ctx.db.insert("projectIdentities", { ...patch, createdAt: now });
  else await ctx.db.patch(existing._id, patch);
  await upsertProjectSearchDocument(ctx, project, patch, key, canonicalProjectIdentityKey, now);
  return canonicalProjectIdentityKey;
};

const findProjectIdentity = async (ctx: MutationCtx, key: string) =>
  await ctx.db
    .query("projectIdentities")
    .withIndex("by_projectIdentityKey", (q) => q.eq("projectIdentityKey", key))
    .unique();

const projectIdentityPatch = (
  project: Record<string, unknown>,
  key: string,
  canonicalProjectIdentityKey: string,
  now: number,
) => ({
  projectIdentityKey: key,
  canonicalProjectIdentityKey,
  displayName: String(project.displayName ?? key),
  confidence: project.confidence as never,
  rawPath: stringValue(project.rawPath),
  normalizedPath: stringValue(project.normalizedPath),
  gitRemote: stringValue(project.gitRemote),
  gitRemoteNormalized: stringValue(project.gitRemoteNormalized),
  packageName: stringValue(project.packageName),
  signals: Array.isArray(project.signals) ? project.signals : [],
  updatedAt: now,
});

const upsertProjectSearchDocument = async (
  ctx: MutationCtx,
  project: Record<string, unknown>,
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
    const rows = await ctx.db.query(tableName).collect();
    for (const row of rows) {
      if (rowMatchesProject(row, sourceProjectIdentityKey)) {
        await ctx.db.patch(row._id, { canonicalProjectIdentityKey: targetCanonical });
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
  const rows = await ctx.db.query("searchDocuments").collect();
  for (const row of rows) {
    if (!rowMatchesProject(row, sourceProjectIdentityKey)) continue;
    const nextContentHash = searchDocumentRagContentHash({
      ...row,
      canonicalProjectIdentityKey: targetCanonical,
    });
    await ctx.db.patch(row._id, {
      canonicalProjectIdentityKey: targetCanonical,
      activeProject: canonicalFilter(targetCanonical),
      ragContentHash: serverEmbeddingsConfigured() ? nextContentHash : undefined,
      ragSyncState: serverEmbeddingsConfigured() ? "pending" : "skipped",
      updatedAt: now,
    });
    await scheduleSearchDocumentRagSync(ctx, row._id, nextContentHash);
  }
};

const rowMatchesProject = (
  row: Pick<Doc<"sessions"> | Doc<"sessionEvents"> | Doc<"toolCalls"> | Doc<"searchDocuments">, "projectIdentityKey" | "canonicalProjectIdentityKey">,
  sourceProjectIdentityKey: string,
) =>
  row.projectIdentityKey === sourceProjectIdentityKey ||
  row.canonicalProjectIdentityKey === sourceProjectIdentityKey;

export const listProjectsHandler = async (ctx: QueryCtx) => {
  const projects = await ctx.db.query("projectIdentities").collect();
  const sessions = await ctx.db.query("sessions").collect();
  return projects
    .map((project) => ({
      projectIdentityKey: project.projectIdentityKey,
      canonicalProjectIdentityKey: project.canonicalProjectIdentityKey,
      displayName: project.displayName,
      confidence: project.confidence,
      rawPath: project.rawPath,
      gitRemoteNormalized: project.gitRemoteNormalized,
      sessionCount: sessions.filter(
        (session) =>
          session.canonicalProjectIdentityKey === project.canonicalProjectIdentityKey,
      ).length,
      updatedAt: project.updatedAt,
    }))
    .sort(
      (left, right) =>
        right.sessionCount - left.sessionCount || right.updatedAt - left.updatedAt,
    );
};

const stringValue = (value: unknown) =>
  typeof value === "string" ? value : undefined;
