import { hostname, platform } from "node:os";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { stableWideHash } from "./hash";
import { allAdapters, readAdapters, stableAdapters } from "./adapters/registry";
import type { AdapterDiscoverOptions, AdapterReadResult, SessionAdapter } from "./adapters/types";
import type {
  IngestBatch,
  IngestManifest,
  MachineIdentity,
  Provider,
  SourceManifestChange,
  SourceManifestEntry,
  SourceSafetyReport,
} from "./schemas";
import { toConvexSafeSessionIntelligenceBatch } from "./session-intelligence";

export const quasarHome = () =>
  process.env.QUASAR_HOME ??
  (process.env.HOME === undefined
    ? ".quasar"
    : join(process.env.HOME, ".config", "quasar"));

const machinePath = () => join(quasarHome(), "machine.json");

export const loadMachineIdentity = (): MachineIdentity => {
  mkdirSync(quasarHome(), { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(readFileSync(machinePath(), "utf8")) as MachineIdentity;
    if (existing.machineId) return existing;
  } catch (error) {
    const ignoredLoadError = error;
    void ignoredLoadError;
    // Create a new stable local identity below.
  }
  const machine: MachineIdentity = {
    machineId: `machine:${stableWideHash(`${hostname()}:${Date.now()}:${Math.random()}`)}`,
    hostname: hostname(),
    platform: platform(),
  };
  writeFileSync(machinePath(), JSON.stringify(machine, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return machine;
};

export interface BuildIngestBatchOptions {
  readonly providers?: readonly Provider[];
  readonly includeExperimental?: boolean;
  readonly limit?: number;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly logicalRoots?: Partial<Record<Provider, string>>;
  readonly machine?: MachineIdentity;
}

export interface StreamIngestBatchOptions extends BuildIngestBatchOptions {
  readonly generatedAt?: string;
}

export const buildIngestBatch = async (
  options: BuildIngestBatchOptions = {},
): Promise<IngestBatch> => {
  const machine = options.machine ?? loadMachineIdentity();
  const adapters = selectedAdapters(options);
  const now = new Date().toISOString();
  const result: AdapterReadResult = await readAdapters(adapters, {
    machine,
    now,
    roots: options.roots,
    logicalRoots: options.logicalRoots,
    limit: options.limit,
  });
  return toConvexSafeSessionIntelligenceBatch({
    protocolVersion: "quasar.ingest/v1",
    machine,
    sourceRoots: result.sourceRoots,
    sessions: result.sessions,
    diagnostics: result.diagnostics,
    generatedAt: now,
  });
};

export async function* streamIngestBatches(
  options: StreamIngestBatchOptions = {},
): AsyncGenerator<IngestBatch> {
  const machine = options.machine ?? loadMachineIdentity();
  const adapters = selectedAdapters(options);
  const now = options.generatedAt ?? new Date().toISOString();
  if (adapters.length === 0) {
    yield toConvexSafeSessionIntelligenceBatch({
      protocolVersion: "quasar.ingest/v1",
      machine,
      sourceRoots: [],
      sessions: [],
      diagnostics: [],
      generatedAt: now,
    });
    return;
  }
  for (const adapter of adapters) {
    if (adapter.stream !== undefined) {
      yield* streamAdapterBatches(adapter, {
        machine,
        now,
        roots: options.roots,
        logicalRoots: options.logicalRoots,
        limit: options.limit,
      });
      continue;
    }
    const result = await adapter.read({
      machine,
      now,
      roots: options.roots,
      logicalRoots: options.logicalRoots,
      limit: options.limit,
    });
    yield toConvexSafeSessionIntelligenceBatch({
      protocolVersion: "quasar.ingest/v1",
      machine,
      sourceRoots: result.sourceRoots,
      sessions: result.sessions,
      diagnostics: result.diagnostics,
      generatedAt: now,
    });
  }
}

async function* streamAdapterBatches(
  adapter: SessionAdapter,
  options: AdapterDiscoverOptions,
): AsyncGenerator<IngestBatch> {
  if (adapter.stream === undefined) return;
  for await (const item of adapter.stream(options)) {
    if (item.type === "sourceRoot") {
      yield toConvexSafeSessionIntelligenceBatch({
        protocolVersion: "quasar.ingest/v1",
        machine: options.machine,
        sourceRoots: [item.sourceRoot],
        sessions: [],
        diagnostics: [],
        generatedAt: options.now,
      });
      continue;
    }
    if (item.type === "diagnostic") {
      yield toConvexSafeSessionIntelligenceBatch({
        protocolVersion: "quasar.ingest/v1",
        machine: options.machine,
        sourceRoots: [],
        sessions: [],
        diagnostics: [item.diagnostic],
        generatedAt: options.now,
      });
      continue;
    }
    yield toConvexSafeSessionIntelligenceBatch({
      protocolVersion: "quasar.ingest/v1",
      machine: options.machine,
      sourceRoots: [],
      sessions: [item.session],
      diagnostics: [],
      generatedAt: options.now,
    });
  }
}

export const summarizeBatch = (batch: IngestBatch) => ({
  machine: batch.machine,
  generatedAt: batch.generatedAt,
  sourceRootCount: batch.sourceRoots.length,
  sessionCount: batch.sessions.length,
  eventCount: batch.sessions.reduce((sum, session) => sum + session.events.length, 0),
  toolCallCount: batch.sessions.reduce(
    (sum, session) => sum + session.toolCalls.length,
    0,
  ),
  contentBlockCount: batch.sessions.reduce(
    (sum, session) =>
      sum + session.events.reduce((eventSum, event) => eventSum + event.contentBlocks.length, 0),
    0,
  ),
  sessionEdgeCount: batch.sessions.reduce(
    (sum, session) => sum + session.sessionEdges.length,
    0,
  ),
  usageRecordCount: batch.sessions.reduce(
    (sum, session) => sum + session.usageRecords.length,
    0,
  ),
  artifactCount: batch.sessions.reduce(
    (sum, session) => sum + session.artifacts.length,
    0,
  ),
  diagnostics: batch.diagnostics,
});

export const manifestFromBatch = (batch: IngestBatch): IngestManifest => {
  const summary = summarizeBatch(batch);
  return {
    protocolVersion: "quasar.ingest-manifest/v1",
    machine: batch.machine,
    sourceRoots: batch.sourceRoots,
    sessions: batch.sessions.map((session) => ({
      id: session.id,
      nativeSessionId: session.nativeSessionId,
      provider: session.provider,
      machineId: session.machineId,
      projectIdentityKey: session.projectIdentity.projectIdentityKey,
      sourceRoot: session.sourceRoot,
      sourcePath: session.sourcePath,
      eventCount: session.events.length,
      toolCallCount: session.toolCalls.length,
      contentBlockCount: session.events.reduce(
        (sum, event) => sum + event.contentBlocks.length,
        0,
      ),
      sessionEdgeCount: session.sessionEdges.length,
      usageRecordCount: session.usageRecords.length,
      artifactCount: session.artifacts.length,
    })),
    diagnostics: batch.diagnostics,
    generatedAt: batch.generatedAt,
    sessionCount: summary.sessionCount,
    eventCount: summary.eventCount,
    toolCallCount: summary.toolCallCount,
    contentBlockCount: summary.contentBlockCount,
    sessionEdgeCount: summary.sessionEdgeCount,
    usageRecordCount: summary.usageRecordCount,
    artifactCount: summary.artifactCount,
  };
};

export const snapshotIngestSourceManifest = (
  batch: IngestBatch,
): SourceManifestEntry[] => {
  const entries = new Map<string, SourceManifestEntry>();
  for (const root of batch.sourceRoots) {
    addSourceManifestEntry(entries, root.rootPath, "source_root");
  }
  for (const session of batch.sessions) {
    addSourceManifestEntry(entries, session.sourcePath, "session_source");
  }
  return [...entries.values()].sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );
};

export const snapshotConfiguredSourceRoots = (
  options: BuildIngestBatchOptions = {},
): SourceManifestEntry[] => {
  const machine = options.machine ?? loadMachineIdentity();
  const adapters = (options.includeExperimental ? allAdapters : stableAdapters).filter(
    (adapter) =>
      options.providers === undefined || options.providers.includes(adapter.provider),
  );
  const entries = new Map<string, SourceManifestEntry>();
  for (const adapter of adapters) {
    const rootPath = options.roots?.[adapter.provider] ?? adapter.defaultRoot() ?? "";
    addSourceManifestEntry(entries, rootPath, "source_root");
    snapshotSourceRootChildren(entries, rootPath);
  }
  return [...entries.values()].sort((left, right) =>
    `${machine.machineId}:${left.path}`.localeCompare(`${machine.machineId}:${right.path}`),
  );
};

export const createSourceSafetyReport = (args: {
  readonly batch?: IngestBatch;
  readonly before: readonly SourceManifestEntry[];
  readonly after: readonly SourceManifestEntry[];
  readonly quasarStateWrites: boolean;
  readonly checkedAt?: string;
}): SourceSafetyReport => ({
  sourceReadMode: "read_only",
  quasarStateWrites: args.quasarStateWrites,
  before: [...args.before],
  after: [...args.after],
  sourceMutations: compareSourceManifests(args.before, args.after),
  checkedAt: args.checkedAt ?? new Date().toISOString(),
});

export const resnapshotSourceManifestEntries = (
  entries: readonly SourceManifestEntry[],
): SourceManifestEntry[] => {
  const next = new Map<string, SourceManifestEntry>();
  for (const entry of entries) addSourceManifestEntry(next, entry.path, entry.role);
  return [...next.values()].sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );
};

export const compareSourceManifests = (
  before: readonly SourceManifestEntry[],
  after: readonly SourceManifestEntry[],
): SourceManifestChange[] => {
  const beforeByKey = new Map(before.map((entry) => [manifestKey(entry), entry]));
  const afterByKey = new Map(after.map((entry) => [manifestKey(entry), entry]));
  const keys = new Set([...beforeByKey.keys(), ...afterByKey.keys()]);
  const changes: SourceManifestChange[] = [];
  for (const key of keys) {
    const beforeEntry = beforeByKey.get(key);
    const afterEntry = afterByKey.get(key);
    const representative = afterEntry ?? beforeEntry;
    if (representative === undefined) continue;
    if (beforeEntry === undefined) {
      changes.push({
        path: representative.path,
        role: representative.role,
        before: beforeEntry,
        after: afterEntry,
        changed: true,
      });
      continue;
    }
    const changed =
      afterEntry === undefined ||
      beforeEntry.exists !== afterEntry.exists ||
      beforeEntry.kind !== afterEntry.kind ||
      beforeEntry.size !== afterEntry.size ||
      beforeEntry.mtimeMs !== afterEntry.mtimeMs ||
      beforeEntry.contentHash !== afterEntry.contentHash;
    if (!changed) continue;
    changes.push({
      path: representative.path,
      role: representative.role,
      before: beforeEntry,
      after: afterEntry,
      changed,
    });
  }
  return changes.sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );
};

const addSourceManifestEntry = (
  entries: Map<string, SourceManifestEntry>,
  path: string,
  role: SourceManifestEntry["role"],
) => {
  const entry = statSource(path, role);
  entries.set(manifestKey(entry), entry);
};

const selectedAdapters = (options: BuildIngestBatchOptions) =>
  (options.includeExperimental ? allAdapters : stableAdapters).filter(
    (adapter) =>
      options.providers === undefined || options.providers.includes(adapter.provider),
  );

const snapshotSourceRootChildren = (
  entries: Map<string, SourceManifestEntry>,
  rootPath: string,
) => {
  const root = statSource(rootPath, "source_root");
  if (!root.exists || root.kind !== "directory") return;
  const pending = [rootPath];
  let visited = 0;
  while (pending.length > 0 && visited < SOURCE_MANIFEST_MAX_ENTRIES) {
    const current = pending.pop();
    if (current === undefined) continue;
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      if (visited >= SOURCE_MANIFEST_MAX_ENTRIES) break;
      const childPath = join(current, name);
      const child = statSource(childPath, "session_source");
      entries.set(manifestKey(child), child);
      visited += 1;
      if (child.exists && child.kind === "directory") pending.push(childPath);
    }
  }
};

const statSource = (path: string, role: SourceManifestEntry["role"]): SourceManifestEntry => {
  if (!existsSync(path)) {
    return { path, role, exists: false, kind: "missing" };
  }
  try {
    const stat = statSync(path);
    return {
      path,
      role,
      exists: true,
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      contentHash: stat.isFile() ? sourceContentHash(path, stat.size) : undefined,
    };
  } catch {
    return { path, role, exists: false, kind: "missing" };
  }
};

const sourceContentHash = (path: string, size: number) => {
  if (size > 20 * 1024 * 1024) return `sha256:skipped-large:${size}`;
  try {
    return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
  } catch {
    return undefined;
  }
};

const manifestKey = (entry: Pick<SourceManifestEntry, "path">) => entry.path;

const SOURCE_MANIFEST_MAX_ENTRIES = 50_000;
