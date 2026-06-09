import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { Args, Command } from "@effect/cli";
import { Duration, Effect, Schema } from "effect";

import {
  allAdapters,
  buildIngestBatch,
  createSourceSafetyReport,
  ImportJobStartResponse,
  ImportJobStatusResponse,
  IngestManifest as IngestManifestSchema,
  MachineIdentity as MachineIdentitySchema,
  SESSION_INTELLIGENCE_CONTRACT_VERSION,
  SourceManifestEntry as SourceManifestEntrySchema,
  jsonByteLength,
  loadMachineIdentity,
  manifestFromBatch,
  Provider as ProviderSchema,
  quasarHome,
  QuasarApiPaths,
  resnapshotSourceManifestEntries,
  snapshotIngestSourceManifest,
  stableCanonicalJsonHash,
  stableJsonHash,
  stableWideHash,
  stableAdapters,
  streamIngestBatches,
  type IngestBatch,
  type IngestManifest,
  type MachineIdentity,
  type NormalizedSession,
  type Provider,
  type SourceManifestEntry,
  type StreamIngestBatchOptions,
  sanitizeIngestBatchForTransport,
  summarizeBatch,
} from "@skastr0/quasar-core";

import { requestJson } from "../api";
import { CommandInputError } from "../errors";
import { loadJsonInput, loadOptionalJsonInput } from "../json";
import { executeJsonCommand } from "../output";
import { IngestOptions } from "../protocol";

const inputArg = Args.text({ name: "input" }).pipe(Args.optional);
const requiredInputArg = Args.text({ name: "input" });

const IngestWaitInput = Schema.Struct({
  importJobId: Schema.String,
  pollIntervalMs: Schema.optional(Schema.Number),
  timeoutMs: Schema.optional(Schema.Number),
});

const toUndefined = <A>(value: { _tag: "Some"; value: A } | { _tag: "None" }) =>
  value._tag === "Some" ? value.value : undefined;

const loadOptions = (input: string | undefined) =>
  loadOptionalJsonInput(IngestOptions, input, {});

type PreparedSourceSnapshot = {
  readonly machine?: MachineIdentity;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly logicalRoots?: Partial<Record<Provider, string>>;
  readonly providers?: readonly Provider[];
  readonly includeExperimental?: boolean;
  readonly limit?: number;
  readonly skip?: number;
  readonly generatedAt?: string;
  readonly plan?: StreamIngestPlan;
  readonly generation?: {
    readonly generationId: string;
    readonly path: string;
  };
  readonly sourceSnapshot: {
    readonly enabled: boolean;
    readonly rootPath?: string;
    readonly copiedProviders: readonly Provider[];
    readonly persistent?: boolean;
    readonly generationId?: string;
  };
};

const withPreparedSourceSnapshot = <A, E, R>(
  options: IngestOptions,
  use: (prepared: PreparedSourceSnapshot) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | Error, R> =>
  Effect.gen(function* () {
    const prepared = yield* prepareSourceSnapshot(options);
    try {
      return yield* use(prepared);
    } finally {
      yield* cleanupSourceSnapshot(prepared);
    }
  });

const prepareSourceSnapshot = (options: IngestOptions) =>
  Effect.try({
    try: () => prepareSourceSnapshotSync(options),
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

const cleanupSourceSnapshot = (prepared: PreparedSourceSnapshot) =>
  Effect.sync(() => {
    if (prepared.sourceSnapshot.persistent === true) return;
    const rootPath = prepared.sourceSnapshot.rootPath;
    if (rootPath === undefined) return;
    try {
      rmSync(rootPath, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup for a temp directory created by this process.
    }
  });

const INGEST_GENERATION_SCHEMA_VERSION = "quasar.ingest-generation/v1";
const INGEST_GENERATION_IDENTITY_VERSION = "quasar.ingest-generation-identity/v3";
const STREAM_INGEST_UPLOAD_IDENTITY_VERSION = "quasar.stream-ingest/v3";
const DURABLE_SNAPSHOT_PROVIDERS = new Set<Provider>([
  "codex",
  "claude",
  "hermes",
  "opencode",
]);
const OPENCODE_DB_FILENAMES = ["opencode-local.db", "opencode.db"] as const;

const PersistedPositiveInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value > 0, {
    message: () => "Expected a positive integer",
  }),
);

const PersistedNonNegativeInteger = Schema.Number.pipe(
  Schema.filter((value) => Number.isInteger(value) && value >= 0, {
    message: () => "Expected a non-negative integer",
  }),
);

const IngestGenerationChunkOptions = Schema.Struct({
  maxEventsPerChunk: PersistedPositiveInteger,
  maxOperationsPerChunk: PersistedPositiveInteger,
});

const IngestGenerationIntent = Schema.Struct({
  identityVersion: Schema.Literal(INGEST_GENERATION_IDENTITY_VERSION),
  sessionIntelligenceContractVersion: Schema.Literal(SESSION_INTELLIGENCE_CONTRACT_VERSION),
  streamIngestUploadIdentityVersion: Schema.Literal(STREAM_INGEST_UPLOAD_IDENTITY_VERSION),
  providers: Schema.Array(ProviderSchema),
  includeExperimental: Schema.Boolean,
  limit: Schema.optional(PersistedPositiveInteger),
  skip: Schema.optional(PersistedNonNegativeInteger),
  roots: Schema.partial(Schema.Record({ key: ProviderSchema, value: Schema.String })),
  logicalRoots: Schema.partial(Schema.Record({ key: ProviderSchema, value: Schema.String })),
  chunkOptions: IngestGenerationChunkOptions,
});
type IngestGenerationIntent = typeof IngestGenerationIntent.Type;

const PersistedIngestGeneration = Schema.Struct({
  schemaVersion: Schema.Literal(INGEST_GENERATION_SCHEMA_VERSION),
  generationId: Schema.String,
  intentHash: Schema.String,
  sourceIdentityKey: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  generatedAt: Schema.String,
  machine: MachineIdentitySchema,
  intent: IngestGenerationIntent,
  roots: Schema.partial(Schema.Record({ key: ProviderSchema, value: Schema.String })),
  logicalRoots: Schema.partial(Schema.Record({ key: ProviderSchema, value: Schema.String })),
  sourceSnapshot: Schema.Struct({
    enabled: Schema.Literal(true),
    rootPath: Schema.String,
    copiedProviders: Schema.Array(ProviderSchema),
  }),
  plan: Schema.Struct({
    manifest: IngestManifestSchema,
    expectedChunkCount: PersistedPositiveInteger,
    chunkPayloadHashes: Schema.Array(Schema.String),
    idempotencyKey: Schema.String,
    sourceBefore: Schema.Array(SourceManifestEntrySchema),
  }),
});
type PersistedIngestGeneration = typeof PersistedIngestGeneration.Type;

const prepareRunSource = (
  options: IngestOptions,
  machine: MachineIdentity,
  generatedAt: string,
  chunkOptions: Required<ChunkOptions>,
) =>
  prepareIngestGeneration(options, machine, generatedAt, chunkOptions).pipe(
    Effect.flatMap((generation) =>
      generation === undefined
        ? prepareSourceSnapshot(options)
        : Effect.succeed(generation),
    ),
  );

const prepareIngestGeneration = (
  options: IngestOptions,
  machine: MachineIdentity,
  generatedAt: string,
  chunkOptions: Required<ChunkOptions>,
) =>
  Effect.gen(function* () {
    if (!shouldUseDurableIngestGeneration(options)) return undefined;
    const intent = ingestGenerationIntent(options, chunkOptions);
    const intentHash = stableJsonHash(intent);
    const generationId = options.ingestGeneration ?? `generation:${intentHash}`;
    assertSafeIngestGenerationId(generationId);
    const directory = ingestGenerationDirectory(generationId);
    const path = ingestGenerationFilePath(generationId);
    if (existsSync(path)) {
      const persisted = readPersistedIngestGeneration(path, generationId);
      if (persisted.intentHash !== intentHash) {
        return yield* new CommandInputError({
          field: "ingestGeneration",
          message: `Ingest generation ${generationId} was created for a different ingest identity; create a new generation or use matching providers, roots, limit, and chunk settings.`,
        });
      }
      return preparedSourceFromGeneration(persisted, path);
    }
    if (options.snapshotSources !== true) {
      return yield* new CommandInputError({
        field: "snapshotSources",
        message: "Creating a durable ingest generation requires snapshotSources: true.",
      });
    }
    const unsupportedProviders = unsupportedDurableSnapshotProviders(intent);
    if (unsupportedProviders.length > 0) {
      return yield* new CommandInputError({
        field: "providers",
        message: `Durable ingest generations require snapshot support for every selected provider with a root; unsupported provider(s): ${unsupportedProviders.join(", ")}.`,
      });
    }
    const created = yield* createPersistedIngestGeneration({
      options,
      machine,
      generatedAt,
      chunkOptions,
      intent,
      intentHash,
      generationId,
      directory,
      path,
    });
    return preparedSourceFromGeneration(created, path);
  });

const shouldUseDurableIngestGeneration = (options: IngestOptions) =>
  options.ingestGeneration !== undefined ||
  (options.snapshotSources === true && maxUploadChunksFromOptions(options) !== undefined);

const unsupportedDurableSnapshotProviders = (intent: IngestGenerationIntent) =>
  intent.providers.filter(
    (provider) =>
      intent.roots[provider] !== undefined &&
      !DURABLE_SNAPSHOT_PROVIDERS.has(provider),
  );

const ingestGenerationIntent = (
  options: IngestOptions,
  chunkOptions: Required<ChunkOptions>,
): IngestGenerationIntent => {
  const adapters = selectedIngestGenerationAdapters(options);
  const roots: Partial<Record<Provider, string>> = {};
  const logicalRoots: Partial<Record<Provider, string>> = {};
  for (const adapter of adapters) {
    const provider = adapter.provider;
    const root = options.roots?.[provider] ?? adapter.defaultRoot();
    if (root !== undefined) roots[provider] = root;
    const logicalRoot = options.logicalRoots?.[provider] ?? root;
    if (logicalRoot !== undefined) logicalRoots[provider] = logicalRoot;
  }
  return {
    identityVersion: INGEST_GENERATION_IDENTITY_VERSION,
    sessionIntelligenceContractVersion: SESSION_INTELLIGENCE_CONTRACT_VERSION,
    streamIngestUploadIdentityVersion: STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
    providers: adapters.map((adapter) => adapter.provider),
    includeExperimental: options.includeExperimental === true,
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.skip !== undefined ? { skip: options.skip } : {}),
    roots,
    logicalRoots,
    chunkOptions,
  };
};

const selectedIngestGenerationAdapters = (options: IngestOptions) => {
  const candidates = (options.includeExperimental === true ? allAdapters : stableAdapters).filter(
    (adapter) =>
      options.providers === undefined || options.providers.includes(adapter.provider),
  );
  if (options.providers !== undefined) return candidates;
  return candidates.filter(
    (adapter) => {
      const provider = adapter.provider;
      const root = options.roots?.[provider] ?? adapter.defaultRoot();
      if (root === undefined) return false;
      if (options.roots?.[provider] !== undefined) return true;
      return DURABLE_SNAPSHOT_PROVIDERS.has(provider) &&
        canSnapshotDurableProviderSource(provider, root);
    },
  );
};

const canSnapshotDurableProviderSource = (provider: Provider, root: string) => {
  switch (provider) {
    case "codex":
      return isDirectory(join(root, "sessions"));
    case "claude":
      return isDirectory(join(root, "projects"));
    case "hermes":
      return sqliteDbPathForRoot(root, "state.db") !== undefined;
    case "opencode":
      return opencodeDbPathForRoot(root) !== undefined;
    default:
      return false;
  }
};

const assertSafeIngestGenerationId = (generationId: string) => {
  if (!/^[A-Za-z0-9:_-]+$/.test(generationId)) {
    throw new CommandInputError({
      field: "ingestGeneration",
      message: "Ingest generation ids may only contain letters, numbers, ':', '_' and '-'.",
    });
  }
};

const ingestGenerationsRoot = () => join(quasarHome(), "ingest-generations", "by-id");
const ingestGenerationDirectory = (generationId: string) =>
  join(ingestGenerationsRoot(), generationId);
const ingestGenerationFilePath = (generationId: string) =>
  join(ingestGenerationDirectory(generationId), "generation.json");

const readPersistedIngestGeneration = (path: string, expectedGenerationId?: string) => {
  try {
    const generation = Schema.decodeUnknownSync(PersistedIngestGeneration)(
      JSON.parse(readFileSync(path, "utf8")),
    );
    assertPersistedIngestGeneration(generation, expectedGenerationId);
    return generation;
  } catch (error) {
    throw new CommandInputError({
      field: "ingestGeneration",
      message: `Failed to read ingest generation ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

const assertPersistedIngestGeneration = (
  generation: PersistedIngestGeneration,
  expectedGenerationId: string | undefined,
) => {
  if (
    expectedGenerationId !== undefined &&
    generation.generationId !== expectedGenerationId
  ) {
    throw new Error(
      `generation id ${generation.generationId} does not match requested id ${expectedGenerationId}`,
    );
  }
  if (generation.sourceIdentityKey !== generation.plan.idempotencyKey) {
    throw new Error("sourceIdentityKey does not match the persisted plan idempotencyKey");
  }
  if (generation.plan.expectedChunkCount !== generation.plan.chunkPayloadHashes.length) {
    throw new Error(
      "expectedChunkCount does not match the persisted chunkPayloadHashes length",
    );
  }
};

const createPersistedIngestGeneration = (input: {
  readonly options: IngestOptions;
  readonly machine: MachineIdentity;
  readonly generatedAt: string;
  readonly chunkOptions: Required<ChunkOptions>;
  readonly intent: IngestGenerationIntent;
  readonly intentHash: string;
  readonly generationId: string;
  readonly directory: string;
  readonly path: string;
}) =>
  Effect.gen(function* () {
    const parent = dirname(input.directory);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tempDirectory = mkdtempSync(join(parent, `${input.generationId.replaceAll(":", "_")}-tmp-`));
    try {
      const tempSourceRoot = join(tempDirectory, "sources");
      const tempSnapshot = prepareSourceSnapshotSync({
        ...input.options,
        snapshotSources: true,
        roots: input.intent.roots,
        logicalRoots: input.intent.logicalRoots,
      }, tempSourceRoot);
      const uncopiedProviders = input.intent.providers.filter(
        (provider) =>
          input.intent.roots[provider] !== undefined &&
          !tempSnapshot.sourceSnapshot.copiedProviders.includes(provider),
      );
      if (uncopiedProviders.length > 0) {
        throw new CommandInputError({
          field: "providers",
          message: `Durable ingest generation could not snapshot selected provider source(s): ${uncopiedProviders.join(", ")}.`,
        });
      }
      const finalSourceRoot = join(input.directory, "sources");
      const finalRoots = rebaseSnapshotRoots(tempSnapshot.roots, tempSourceRoot, finalSourceRoot);
      const streamOptions = {
        providers: input.intent.providers,
        includeExperimental: input.intent.includeExperimental,
        limit: input.intent.limit,
        skip: input.intent.skip,
        roots: tempSnapshot.roots,
        logicalRoots: tempSnapshot.logicalRoots,
        machine: input.machine,
        generatedAt: input.generatedAt,
      };
      const plan = yield* planStreamedIngest(streamOptions, input.chunkOptions);
      const persisted: PersistedIngestGeneration = {
        schemaVersion: INGEST_GENERATION_SCHEMA_VERSION,
        generationId: input.generationId,
        intentHash: input.intentHash,
        sourceIdentityKey: plan.idempotencyKey,
        createdAt: input.generatedAt,
        updatedAt: input.generatedAt,
        generatedAt: input.generatedAt,
        machine: input.machine,
        intent: input.intent,
        roots: finalRoots,
        logicalRoots: tempSnapshot.logicalRoots ?? {},
        sourceSnapshot: {
          enabled: true,
          rootPath: finalSourceRoot,
          copiedProviders: [...tempSnapshot.sourceSnapshot.copiedProviders],
        },
        plan: {
          manifest: plan.manifest,
          expectedChunkCount: plan.expectedChunkCount,
          chunkPayloadHashes: [...plan.chunkPayloadHashes],
          idempotencyKey: plan.idempotencyKey,
          sourceBefore: [...plan.sourceBefore],
        },
      };
      writeFileSync(
        join(tempDirectory, "generation.json"),
        `${JSON.stringify(persisted, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      if (existsSync(input.directory)) {
        rmSync(tempDirectory, { recursive: true, force: true });
        return readPersistedIngestGeneration(input.path, input.generationId);
      }
      renameSync(tempDirectory, input.directory);
      return persisted;
    } catch (error) {
      rmSync(tempDirectory, { recursive: true, force: true });
      throw error;
    }
  });

const rebaseSnapshotRoots = (
  roots: Partial<Record<Provider, string>> | undefined,
  fromRoot: string,
  toRoot: string,
) => {
  const rebased: Partial<Record<Provider, string>> = {};
  for (const [provider, root] of Object.entries(roots ?? {}) as Array<[Provider, string]>) {
    rebased[provider] = root.startsWith(fromRoot)
      ? `${toRoot}${root.slice(fromRoot.length)}`
      : root;
  }
  return rebased;
};

const preparedSourceFromGeneration = (
  generation: PersistedIngestGeneration,
  path: string,
): PreparedSourceSnapshot => {
  if (!existsSync(generation.sourceSnapshot.rootPath)) {
    throw new CommandInputError({
      field: "ingestGeneration",
      message: `Ingest generation ${generation.generationId} is missing its source snapshot at ${generation.sourceSnapshot.rootPath}.`,
    });
  }
  return {
    machine: generation.machine,
    roots: generation.roots,
    logicalRoots: generation.logicalRoots,
    providers: generation.intent.providers,
    includeExperimental: generation.intent.includeExperimental,
    limit: generation.intent.limit,
    skip: generation.intent.skip,
    generatedAt: generation.generatedAt,
    plan: {
      manifest: generation.plan.manifest,
      expectedChunkCount: generation.plan.expectedChunkCount,
      chunkPayloadHashes: generation.plan.chunkPayloadHashes,
      idempotencyKey: generation.plan.idempotencyKey,
      sourceBefore: generation.plan.sourceBefore,
    },
    generation: {
      generationId: generation.generationId,
      path,
    },
    sourceSnapshot: {
      enabled: true,
      rootPath: generation.sourceSnapshot.rootPath,
      copiedProviders: generation.sourceSnapshot.copiedProviders,
      persistent: true,
      generationId: generation.generationId,
    },
  };
};

const prepareSourceSnapshotSync = (
  options: IngestOptions,
  targetSnapshotRoot?: string,
): PreparedSourceSnapshot => {
  if (options.snapshotSources !== true) {
    return {
      roots: options.roots,
      logicalRoots: options.logicalRoots,
      sourceSnapshot: { enabled: false, copiedProviders: [] },
    };
  }

  const snapshotRoot = targetSnapshotRoot ?? mkdtempSync(join(tmpdir(), "qis-"));
  if (targetSnapshotRoot !== undefined) mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 });
  const roots: Partial<Record<Provider, string>> = { ...(options.roots ?? {}) };
  const logicalRoots: Partial<Record<Provider, string>> = { ...(options.logicalRoots ?? {}) };
  const copiedProviders: Provider[] = [];
  const adapters = (options.includeExperimental === true ? allAdapters : stableAdapters).filter(
    (adapter) =>
      options.providers === undefined || options.providers.includes(adapter.provider),
  );

  for (const adapter of adapters) {
    const provider = adapter.provider;
    const originalRoot = options.roots?.[provider] ?? adapter.defaultRoot();
    if (originalRoot === undefined) continue;
    const snapshotProviderRoot = snapshotProviderSource(
      provider,
      originalRoot,
      snapshotRoot,
    );
    if (snapshotProviderRoot === undefined) continue;
    roots[provider] = snapshotProviderRoot;
    logicalRoots[provider] = options.logicalRoots?.[provider] ?? originalRoot;
    copiedProviders.push(provider);
  }

  return {
    roots,
    logicalRoots,
    sourceSnapshot: { enabled: true, rootPath: snapshotRoot, copiedProviders },
  };
};

const snapshotProviderSource = (
  provider: Provider,
  originalRoot: string,
  snapshotRoot: string,
) => {
  switch (provider) {
    case "codex":
      return snapshotDirectoryProvider(
        join(originalRoot, "sessions"),
        join(snapshotRoot, "codex"),
        "sessions",
      );
    case "claude":
      return snapshotDirectoryProvider(
        join(originalRoot, "projects"),
        join(snapshotRoot, "claude"),
        "projects",
      );
    case "hermes": {
      const sourceDbPath = sqliteDbPathForRoot(originalRoot, "state.db");
      if (sourceDbPath === undefined) return undefined;
      const snapshotProviderRoot = join(snapshotRoot, "hermes");
      snapshotSqliteDatabase(sourceDbPath, join(snapshotProviderRoot, "state.db"));
      return snapshotProviderRoot;
    }
    case "opencode": {
      const sourceDbPath = opencodeDbPathForRoot(originalRoot);
      if (sourceDbPath === undefined) return undefined;
      const snapshotProviderRoot = join(snapshotRoot, "opencode");
      snapshotSqliteDatabase(sourceDbPath, join(snapshotProviderRoot, basename(sourceDbPath)));
      return snapshotProviderRoot;
    }
    default:
      return undefined;
  }
};

const snapshotDirectoryProvider = (
  sourceDirectory: string,
  snapshotProviderRoot: string,
  childName: string,
) => {
  if (!isDirectory(sourceDirectory)) return undefined;
  mkdirSync(snapshotProviderRoot, { recursive: true });
  cpSync(sourceDirectory, join(snapshotProviderRoot, childName), {
    recursive: true,
    force: true,
  });
  return snapshotProviderRoot;
};

const sqliteDbPathForRoot = (root: string, filename: string) => {
  try {
    if (statSync(root).isFile()) return root;
  } catch {
    return undefined;
  }
  const dbPath = join(root, filename);
  return existsSync(dbPath) ? dbPath : undefined;
};

const opencodeDbPathForRoot = (root: string) => {
  try {
    if (statSync(root).isFile()) return root;
  } catch {
    return undefined;
  }
  for (const filename of OPENCODE_DB_FILENAMES) {
    const dbPath = join(root, filename);
    if (existsSync(dbPath)) return dbPath;
  }
  return undefined;
};

const snapshotSqliteDatabase = (sourceDbPath: string, destinationDbPath: string) => {
  mkdirSync(dirname(destinationDbPath), { recursive: true });
  try {
    execFileSync("sqlite3", [
      sourceDbPath,
      `.backup ${sqliteDotCommandQuote(destinationDbPath)}`,
    ], { stdio: "pipe" });
    return;
  } catch {
    copyFileSync(sourceDbPath, destinationDbPath);
    for (const suffix of ["-wal", "-shm"]) {
      const source = `${sourceDbPath}${suffix}`;
      if (existsSync(source)) copyFileSync(source, `${destinationDbPath}${suffix}`);
    }
  }
};

const sqliteDotCommandQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

const isDirectory = (path: string) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const buildBatchWithSourceSnapshotEffect = (input: string | undefined) =>
  Effect.gen(function* () {
    const options = yield* loadOptions(input);
    const { before, batch } = yield* withPreparedSourceSnapshot(options, (prepared) => {
      return Effect.tryPromise({
        try: async () => {
          const batch = await buildIngestBatch({
            providers: options.providers,
            includeExperimental: options.includeExperimental,
            limit: options.limit,
            skip: options.skip,
            roots: prepared.roots,
            logicalRoots: prepared.logicalRoots,
          });
          return {
            before: snapshotIngestSourceManifest(batch),
            batch,
          };
        },
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    });
    return { options, before, batch };
  });

const buildStreamedPlanEffect = (input: string | undefined) =>
  Effect.gen(function* () {
    const options = yield* loadOptions(input);
    const machine = loadMachineIdentity();
    const generatedAt = new Date().toISOString();
    const chunkOptions = chunkOptionsFromEnv();
    return yield* withPreparedSourceSnapshot(options, (prepared) =>
      planStreamedIngest(
        {
          providers: options.providers,
          includeExperimental: options.includeExperimental,
          limit: options.limit,
          skip: options.skip,
          roots: prepared.roots,
          logicalRoots: prepared.logicalRoots,
          machine,
          generatedAt,
        },
        chunkOptions,
      ).pipe(
        Effect.map((plan) => ({
          plan,
          selection: {
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.skip !== undefined ? { skip: options.skip } : {}),
          },
        })),
      )
    );
  });

const readImportJob = (
  importJobId: string,
  requestClient: IngestRequestClient = requestJson,
  options: {
    readonly limit?: number;
    readonly chunkCursor?: string;
    readonly failureCursor?: string;
  } = {},
) =>
  requestClient({
    method: "GET",
    path: QuasarApiPaths.ingestJobs,
    query: {
      importJobId,
      ...(options.limit !== undefined ? { limit: String(options.limit) } : {}),
      chunkCursor: options.chunkCursor,
      failureCursor: options.failureCursor,
    },
    responseSchema: ImportJobStatusResponse,
  }).pipe(
    Effect.map((status) => ({
      ...status,
      importJobId,
      jobStatus: jobStatusFromPayload(status.job),
    })),
  );

const ensureImportWorkerScheduled = (
  importJobId: string,
  requestClient: IngestRequestClient = requestJson,
) =>
  requestClient({
    method: "POST",
    path: QuasarApiPaths.ingestJobsSchedule,
    body: { importJobId },
    responseSchema: Schema.Unknown,
  }).pipe(Effect.asVoid);

const safeResumeUploadedChunkCount = (
  importJobId: string,
  plan: StreamIngestPlan,
  requestClient: IngestRequestClient,
) =>
  Effect.gen(function* () {
    let nextSequence = 0;
    let chunkCursor: string | undefined;
    while (nextSequence < plan.expectedChunkCount) {
      const status = yield* readImportJob(importJobId, requestClient, {
        limit: RESUME_STATUS_PAGE_LIMIT,
        chunkCursor,
      });
      const chunks = chunkStatusRows(status.chunks).sort(
        (left, right) => chunkSequence(left) - chunkSequence(right),
      );
      if (chunks.length === 0) return nextSequence;
      for (const chunk of chunks) {
        const sequence = chunkSequence(chunk);
        if (sequence !== nextSequence) return nextSequence;
        const compatibility = chunkResumeCompatibility(chunk, importJobId, plan, sequence);
        if (compatibility === "incompatible") {
          throw new Error(
            `import job ${importJobId} has an incompatible chunk at sequence ${sequence}`,
          );
        }
        if (compatibility === "repair") return nextSequence;
        nextSequence += 1;
        if (nextSequence >= plan.expectedChunkCount) return nextSequence;
      }
      const nextCursor = chunkPaginationCursor(status.pagination);
      if (nextCursor === undefined) return nextSequence;
      chunkCursor = nextCursor;
    }
    return nextSequence;
  });

const RESUME_STATUS_PAGE_LIMIT = 200;

const chunkStatusRows = (chunks: unknown) =>
  Array.isArray(chunks)
    ? chunks.filter((chunk): chunk is Record<string, unknown> =>
        chunk !== null && typeof chunk === "object",
      )
    : [];

const chunkSequence = (chunk: Record<string, unknown>) => {
  const sequence = chunk.sequence;
  return typeof sequence === "number" && Number.isInteger(sequence)
    ? sequence
    : Number.POSITIVE_INFINITY;
};

const chunkResumeCompatibility = (
  chunk: Record<string, unknown>,
  importJobId: string,
  plan: StreamIngestPlan,
  sequence: number,
): "safe" | "repair" | "incompatible" => {
  const expectedHash = plan.chunkPayloadHashes[sequence];
  if (typeof expectedHash !== "string") return "incompatible";
  const expectedIdempotencyKey = ingestChunkIdempotencyKey(
    importJobId,
    sequence,
    expectedHash,
  );
  if (chunk.idempotencyKey !== expectedIdempotencyKey) {
    return "incompatible";
  }
  if (chunk.status === "succeeded") return "safe";
  if (
    (chunk.status === "pending" || chunk.status === "running") &&
    chunk.payloadStored === true
  ) return "safe";
  return "repair";
};

const chunkPaginationCursor = (pagination: unknown) => {
  if (pagination === null || typeof pagination !== "object") return undefined;
  const chunks = (pagination as Record<string, unknown>).chunks;
  if (chunks === null || typeof chunks !== "object") return undefined;
  const page = chunks as Record<string, unknown>;
  if (page.isDone === true) return undefined;
  return typeof page.continueCursor === "string" && page.continueCursor.length > 0
    ? page.continueCursor
    : undefined;
};

const jobStatusFromPayload = (job: unknown) => {
  if (job !== null && typeof job === "object" && "status" in job) {
    const status = (job as Record<string, unknown>).status;
    if (typeof status === "string") return status;
  }
  return "unknown";
};

const isClosedImportJobStatus = (status: string) =>
  status === "failed" || status === "partial_failure";

const DEFAULT_DRAIN_POLL_INTERVAL_MS = 1_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_DRAIN_RESCHEDULE_INTERVAL_MS = 30_000;
const DEFAULT_IN_FLIGHT_HIGH_WATERMARK = 0;

type ImportJobStatusSnapshot = {
  readonly job: unknown;
  readonly chunks?: readonly unknown[];
  readonly failures?: readonly unknown[];
  readonly readiness: unknown;
  readonly pagination?: unknown;
  readonly importJobId: string;
  readonly jobStatus: string;
};

type DrainOptions = {
  readonly pollIntervalMs: number;
  readonly timeoutMs: number;
  readonly rescheduleIntervalMs: number;
  readonly inFlightHighWatermark: number;
};

type DrainResult = {
  readonly timedOut: boolean;
  readonly inFlightChunkCount: number;
  readonly uploadedChunkCount?: number;
  readonly terminalChunkCount?: number;
  readonly status: ImportJobStatusSnapshot;
};

const drainOptionsFromOptions = (options: IngestOptions): DrainOptions => ({
  pollIntervalMs: positiveInteger(
    options.drainPollIntervalMs ??
      envPositiveInteger("QUASAR_INGEST_DRAIN_POLL_MS", DEFAULT_DRAIN_POLL_INTERVAL_MS),
    DEFAULT_DRAIN_POLL_INTERVAL_MS,
  ),
  timeoutMs: nonNegativeInteger(
    options.drainTimeoutMs ??
      envPositiveInteger("QUASAR_INGEST_DRAIN_TIMEOUT_MS", DEFAULT_DRAIN_TIMEOUT_MS),
    DEFAULT_DRAIN_TIMEOUT_MS,
  ),
  rescheduleIntervalMs: positiveInteger(
    options.drainRescheduleIntervalMs ??
      envPositiveInteger("QUASAR_INGEST_DRAIN_RESCHEDULE_MS", DEFAULT_DRAIN_RESCHEDULE_INTERVAL_MS),
    DEFAULT_DRAIN_RESCHEDULE_INTERVAL_MS,
  ),
  inFlightHighWatermark: nonNegativeInteger(
    options.inFlightHighWatermark ??
      envPositiveInteger("QUASAR_INGEST_IN_FLIGHT_HIGH_WATERMARK", DEFAULT_IN_FLIGHT_HIGH_WATERMARK),
    DEFAULT_IN_FLIGHT_HIGH_WATERMARK,
  ),
});

const waitForImportJobDrain = (
  importJobId: string,
  requestClient: IngestRequestClient,
  options: DrainOptions,
  scheduling: { readonly scheduleWorker: boolean; readonly alreadyScheduled: boolean },
) =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    let lastScheduledAt = scheduling.alreadyScheduled ? startedAt : undefined;
    while (true) {
      const status = yield* readImportJob(importJobId, requestClient, { limit: 0 });
      const summary = importJobDrainSummary(status);
      if (
        summary.inFlightChunkCount <= options.inFlightHighWatermark ||
        isFinalJobStatus(status.jobStatus)
      ) {
        return { ...summary, timedOut: false, status };
      }
      const now = Date.now();
      if (
        scheduling.scheduleWorker &&
        (lastScheduledAt === undefined || now - lastScheduledAt >= options.rescheduleIntervalMs)
      ) {
        yield* ensureImportWorkerScheduled(importJobId, requestClient);
        lastScheduledAt = now;
      }
      if (now - startedAt >= options.timeoutMs) {
        return { ...summary, timedOut: true, status };
      }
      yield* Effect.sleep(Duration.millis(options.pollIntervalMs));
    }
  });

const drainPublicResult = (result: DrainResult) => ({
  timedOut: result.timedOut,
  inFlightChunkCount: result.inFlightChunkCount,
  ...(result.uploadedChunkCount !== undefined ? { uploadedChunkCount: result.uploadedChunkCount } : {}),
  ...(result.terminalChunkCount !== undefined ? { terminalChunkCount: result.terminalChunkCount } : {}),
});

const importJobDrainSummary = (status: ImportJobStatusSnapshot) => {
  const job = status.job;
  const uploaded = jobNumber(job, "uploadedChunkCount") ?? jobNumber(job, "chunkCount") ?? 0;
  const succeeded = jobNumber(job, "succeededChunkCount") ?? 0;
  const failed = jobNumber(job, "failedChunkCount") ?? 0;
  const terminal = succeeded + failed;
  return {
    inFlightChunkCount: Math.max(0, uploaded - terminal),
    uploadedChunkCount: uploaded,
    terminalChunkCount: terminal,
  };
};

const jobNumber = (job: unknown, key: string) => {
  if (job === null || typeof job !== "object") return undefined;
  const value = (job as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

const validateCommand = Command.make("validate", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest validate",
    buildBatchWithSourceSnapshotEffect(toUndefined(input)).pipe(
      Effect.map(({ before, batch: rawBatch }) => {
        const batch = sanitizeIngestBatchForTransport(rawBatch);
        const after = snapshotIngestSourceManifest(batch);
        return {
          ...summarizeBatch(batch),
          sourceSafetyReport: createSourceSafetyReport({
            batch,
            before,
            after,
            quasarStateWrites: false,
          }),
        };
      }),
    ),
  ),
);

const planCommand = Command.make("plan", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest plan",
    buildStreamedPlanEffect(toUndefined(input)).pipe(
      Effect.map(({ plan, selection }) => ({
        ...summaryFromManifest(plan.manifest),
        chunkCount: plan.expectedChunkCount,
        selection,
        sessions: plan.manifest.sessions.map((session) => ({
          id: session.id,
          provider: session.provider,
          nativeSessionId: session.nativeSessionId,
          eventCount: session.eventCount,
          sourcePath: session.sourcePath,
        })),
      })),
    ),
  ),
);

type IngestRequestClient = typeof requestJson;
const IngestRequestClientSchema = Schema.instanceOf(Function);

const runPreparedIngest = (input: {
  readonly options: IngestOptions;
  readonly client: IngestRequestClient;
  readonly machine: MachineIdentity;
  readonly generatedAt: string;
  readonly chunkOptions: Required<ChunkOptions>;
  readonly prepared: PreparedSourceSnapshot;
}) =>
  Effect.gen(function* () {
    const streamGeneratedAt = input.prepared.generatedAt ?? input.generatedAt;
    const streamMachine = input.prepared.machine ?? input.machine;
    const streamOptions = {
      providers: input.prepared.providers ?? input.options.providers,
      includeExperimental: input.prepared.includeExperimental ?? input.options.includeExperimental,
      limit: input.prepared.limit ?? input.options.limit,
      skip: input.prepared.skip ?? input.options.skip,
      roots: input.prepared.roots,
      logicalRoots: input.prepared.logicalRoots,
      machine: streamMachine,
      generatedAt: streamGeneratedAt,
    };
    const plan = input.prepared.plan ??
      (yield* planStreamedIngest(streamOptions, input.chunkOptions));
    const job = yield* input.client({
      method: "POST",
      path: QuasarApiPaths.ingestJobs,
      body: {
        manifest: plan.manifest,
        sourceIdentityKey: plan.idempotencyKey,
        expectedChunkCount: plan.expectedChunkCount,
      },
      responseSchema: ImportJobStartResponse,
    });
    if (isClosedImportJobStatus(job.status)) {
      return yield* new CommandInputError({
        field: "importJobId",
        message: `Import job ${job.importJobId} is ${job.status}; create a fresh ingest attempt.`,
      });
    }
    const drainOptions = drainOptionsFromOptions(input.options);
    const preUploadDrain = job.chunkCount <= 0
      ? undefined
      : yield* waitForImportJobDrain(job.importJobId, input.client, drainOptions, {
          scheduleWorker: true,
          alreadyScheduled: false,
        });
    if (preUploadDrain?.timedOut === true) {
      return yield* new CommandInputError({
        field: "importJobId",
        message: `Import job ${job.importJobId} still has ${preUploadDrain.inFlightChunkCount} in-flight chunk(s); retry after the worker drains them.`,
      });
    }
    const chunkDelayMs = envPositiveInteger(
      "QUASAR_INGEST_CHUNK_DELAY_MS",
      DEFAULT_CHUNK_DELAY_MS,
    );
    const upload = yield* uploadStreamedIngest({
      streamOptions,
      chunkOptions: input.chunkOptions,
      plan,
      client: input.client,
      importJobId: job.importJobId,
      resumeUploadedChunkCount: job.chunkCount <= 0
        ? 0
        : yield* safeResumeUploadedChunkCount(job.importJobId, plan, input.client),
      uploadGroupSize: uploadGroupSizeFromEnv(),
      maxUploadChunksPerRun: maxUploadChunksFromOptions(input.options),
      chunkDelayMs,
      progress: progressOptionsFromEnv(),
    });
    if (upload.uploadedThisRunCount > 0 || upload.uploadComplete) {
      yield* ensureImportWorkerScheduled(job.importJobId, input.client);
    }
    const postUploadDrain = upload.uploadedThisRunCount > 0 || upload.uploadComplete
      ? yield* waitForImportJobDrain(job.importJobId, input.client, drainOptions, {
          scheduleWorker: true,
          alreadyScheduled: true,
        })
      : undefined;
    const status = postUploadDrain?.status ??
      (yield* readImportJob(job.importJobId, input.client, { limit: 0 }));
    const after = resnapshotSourceManifestEntries(plan.sourceBefore);
    return {
      ...summaryFromManifest(plan.manifest),
      importJobId: job.importJobId,
      jobStatus: status.jobStatus,
      chunkCount: plan.expectedChunkCount,
      uploadedChunkCount: upload.uploadedChunkCount,
      uploadedThisRunCount: upload.uploadedThisRunCount,
      skippedUploadedChunkCount: upload.skippedUploadedChunkCount,
      uploadGroupCount: upload.uploadGroupCount,
      uploadComplete: upload.uploadComplete,
      uploadStoppedEarly: upload.uploadStoppedEarly,
      drain: {
        ...(preUploadDrain !== undefined ? { beforeUpload: drainPublicResult(preUploadDrain) } : {}),
        ...(postUploadDrain !== undefined ? { afterUpload: drainPublicResult(postUploadDrain) } : {}),
      },
      status,
      ingestGeneration: input.prepared.generation,
      sourceSnapshot: input.prepared.sourceSnapshot,
      sourceSafetyReport: createSourceSafetyReport({
        before: plan.sourceBefore,
        after,
        quasarStateWrites: true,
      }),
    };
  });

export const runIngestEffect = (
  input: string | undefined,
  requestClient: IngestRequestClient = requestJson,
) =>
  Effect.gen(function* () {
    const client = (yield* Schema.decodeUnknown(IngestRequestClientSchema)(
      requestClient,
    )) as IngestRequestClient;
    const options = yield* loadOptions(input);
    if (options.dryRun === true) {
      const { before, batch: rawBatch } = yield* buildBatchWithSourceSnapshotEffect(input);
      const batch = sanitizeIngestBatchForTransport(rawBatch);
      const after = snapshotIngestSourceManifest(batch);
      return {
        dryRun: true,
        summary: summarizeBatch(batch),
        sourceSafetyReport: createSourceSafetyReport({
          batch,
          before,
          after,
          quasarStateWrites: false,
        }),
      };
    }
    const machine = loadMachineIdentity();
    const generatedAt = new Date().toISOString();
    const chunkOptions = chunkOptionsFromEnv();
    const prepared = yield* prepareRunSource(options, machine, generatedAt, chunkOptions);
    try {
      return yield* runPreparedIngest({
        options,
        client,
        machine,
        generatedAt,
        chunkOptions,
        prepared,
      });
    } finally {
      yield* cleanupSourceSnapshot(prepared);
    }
  });

const runCommand = Command.make("run", { input: inputArg }, ({ input }) =>
  executeJsonCommand("ingest run", runIngestEffect(toUndefined(input))),
);

export const MAX_EVENTS_PER_CHUNK = 10;
export const MAX_OPERATIONS_PER_CHUNK = 35;
export const DEFAULT_CHUNK_DELAY_MS = 750;
export const DEFAULT_UPLOAD_GROUP_SIZE = 10;
export const MAX_UPLOAD_CHUNK_BATCH_BYTES = 768 * 1024;
export const MAX_BULK_UPLOAD_BODY_BYTES = 3_500_000;

export interface ChunkOptions {
  readonly maxEventsPerChunk?: number;
  readonly maxOperationsPerChunk?: number;
}

const chunkOptionsFromEnv = (): Required<ChunkOptions> => ({
  maxEventsPerChunk: envPositiveInteger(
    "QUASAR_INGEST_MAX_EVENTS_PER_CHUNK",
    MAX_EVENTS_PER_CHUNK,
  ),
  maxOperationsPerChunk: envPositiveInteger(
    "QUASAR_INGEST_MAX_OPERATIONS_PER_CHUNK",
    MAX_OPERATIONS_PER_CHUNK,
  ),
});

const uploadGroupSizeFromEnv = () =>
  Math.max(
    1,
    envPositiveInteger("QUASAR_INGEST_UPLOAD_GROUP_SIZE", DEFAULT_UPLOAD_GROUP_SIZE),
  );

const maxUploadChunksFromOptions = (options: IngestOptions) =>
  positiveIntegerOrUndefined(options.maxUploadChunks) ??
  envOptionalPositiveInteger("QUASAR_INGEST_MAX_UPLOAD_CHUNKS");

type StreamIngestOptions = StreamIngestBatchOptions & {
  readonly machine: MachineIdentity;
  readonly generatedAt: string;
};

type StreamIngestPlan = {
  readonly manifest: IngestManifest;
  readonly expectedChunkCount: number;
  readonly chunkPayloadHashes: readonly string[];
  readonly idempotencyKey: string;
  readonly sourceBefore: readonly SourceManifestEntry[];
};

type IngestManifestDraft = {
  protocolVersion: "quasar.ingest-manifest/v1";
  machine: IngestManifest["machine"];
  sourceRoots: IngestManifest["sourceRoots"][number][];
  sessions: IngestManifest["sessions"][number][];
  diagnostics: IngestManifest["diagnostics"][number][];
  generatedAt: string;
  sessionCount: number;
  eventCount: number;
  toolCallCount: number;
  contentBlockCount: number;
  sessionEdgeCount: number;
  usageRecordCount: number;
  artifactCount: number;
};

const planStreamedIngest = (
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
) =>
  Effect.tryPromise({
    try: async () => {
      const manifest = emptyIngestManifest(streamOptions.machine, streamOptions.generatedAt);
      const sourceBefore = new Map<string, SourceManifestEntry>();
      const chunkPayloadHashes: string[] = [];
      for await (const batch of streamIngestBatches(streamOptions)) {
        mergeManifest(manifest, manifestFromBatch(batch));
        for (const entry of snapshotIngestSourceManifest(batch)) {
          sourceBefore.set(sourceManifestKey(entry), entry);
        }
        const chunks = chunkIngestBatch(batch, chunkOptions);
        validateChunkPayloads(chunks);
        for (const chunk of chunks) {
          chunkPayloadHashes.push(ingestBatchPayloadHash(chunk));
        }
      }
      const plannedManifest: IngestManifest = manifest;
      return {
        manifest: plannedManifest,
        expectedChunkCount: chunkPayloadHashes.length,
        chunkPayloadHashes,
        idempotencyKey: streamedIngestJobIdempotencyKey(plannedManifest, chunkPayloadHashes),
        sourceBefore: sortedSourceManifestEntries(sourceBefore.values()),
      };
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

const uploadStreamedIngest = (input: {
  readonly streamOptions: StreamIngestOptions;
  readonly chunkOptions: Required<ChunkOptions>;
  readonly plan: StreamIngestPlan;
  readonly client: IngestRequestClient;
  readonly importJobId: string;
  readonly resumeUploadedChunkCount: number;
  readonly uploadGroupSize: number;
  readonly maxUploadChunksPerRun?: number;
  readonly chunkDelayMs: number;
  readonly progress: UploadProgressOptions;
}) =>
  Effect.gen(function* () {
    const iterator = streamChunkBatches(input.streamOptions, input.chunkOptions)[Symbol.asyncIterator]();
    let group: Array<{ chunk: IngestBatch; index: number }> = [];
    const skippedUploadedChunkCount = Math.min(
      Math.max(0, input.resumeUploadedChunkCount),
      input.plan.expectedChunkCount,
    );
    let uploadedThisRunCount = 0;
    let uploadedChunkCount = skippedUploadedChunkCount;
    let uploadGroupCount = 0;
    let uploadStoppedEarly = false;
    let index = 0;
    yield* emitUploadProgress(input, uploadedChunkCount, uploadGroupCount);
    if (skippedUploadedChunkCount >= input.plan.expectedChunkCount) {
      return {
        uploadedChunkCount,
        uploadedThisRunCount,
        skippedUploadedChunkCount,
        uploadGroupCount,
        uploadComplete: true,
        uploadStoppedEarly: false,
      };
    }
    while (true) {
      if (
        input.maxUploadChunksPerRun !== undefined &&
        uploadedThisRunCount + group.length >= input.maxUploadChunksPerRun
      ) {
        uploadStoppedEarly = true;
        break;
      }
      const next = yield* Effect.tryPromise({
        try: () => iterator.next(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      if (next.done === true) break;
      const chunk = next.value;
      if (index < skippedUploadedChunkCount) {
        index += 1;
        continue;
      }
      assertJsonBudget(chunk, MAX_UPLOAD_CHUNK_BATCH_BYTES, `chunk ${index}`);
      const expectedHash = input.plan.chunkPayloadHashes[index];
      const actualHash = ingestBatchPayloadHash(chunk);
      if (expectedHash !== actualHash) {
        throw new Error(`ingest source changed between planning and upload at chunk ${index}`);
      }
      const item = { chunk, index };
      const candidate = [...group, item];
      const nextBytes = jsonByteLength(
        bulkUploadRequestBody(input.importJobId, input.plan, candidate),
      );
      if (
        group.length > 0 &&
        (group.length >= input.uploadGroupSize || nextBytes > MAX_BULK_UPLOAD_BODY_BYTES)
      ) {
        yield* uploadChunkGroup(input, group);
        uploadedThisRunCount += group.length;
        uploadedChunkCount += group.length;
        uploadGroupCount += 1;
        yield* emitUploadProgress(input, uploadedChunkCount, uploadGroupCount);
        group = [item];
      } else {
        group = candidate;
      }
      index += 1;
    }
    if (group.length > 0) {
      yield* uploadChunkGroup(input, group);
      uploadedThisRunCount += group.length;
      uploadedChunkCount += group.length;
      uploadGroupCount += 1;
      yield* emitUploadProgress(input, uploadedChunkCount, uploadGroupCount, {
        force: uploadStoppedEarly,
      });
    }
    if (!uploadStoppedEarly && index !== input.plan.expectedChunkCount) {
      throw new Error(
        `ingest planned ${input.plan.expectedChunkCount} chunks but uploaded ${index}`,
      );
    }
    return {
      uploadedChunkCount,
      uploadedThisRunCount,
      skippedUploadedChunkCount,
      uploadGroupCount,
      uploadComplete: uploadedChunkCount >= input.plan.expectedChunkCount,
      uploadStoppedEarly,
    };
  });

type UploadProgressOptions = {
  readonly enabled: boolean;
  readonly intervalChunks: number;
};

const progressOptionsFromEnv = (): UploadProgressOptions => ({
  enabled: process.env.QUASAR_INGEST_PROGRESS === "1",
  intervalChunks: Math.max(
    1,
    envPositiveInteger("QUASAR_INGEST_PROGRESS_INTERVAL", 100),
  ),
});

const emitUploadProgress = (
  input: {
    readonly importJobId: string;
    readonly plan: StreamIngestPlan;
    readonly progress: UploadProgressOptions;
  },
  uploadedChunkCount: number,
  uploadGroupCount: number,
  options: { readonly force?: boolean } = {},
) =>
  Effect.sync(() => {
    if (!input.progress.enabled) return;
    const complete = uploadedChunkCount >= input.plan.expectedChunkCount;
    const resumed = uploadGroupCount === 0 && uploadedChunkCount > 0;
    if (
      options.force !== true &&
      !complete &&
      !resumed &&
      uploadedChunkCount % input.progress.intervalChunks !== 0
    ) return;
    process.stderr.write(
      `${JSON.stringify({
        event: "quasar.ingest.upload_progress",
        importJobId: input.importJobId,
        uploadedChunkCount,
        expectedChunkCount: input.plan.expectedChunkCount,
        uploadGroupCount,
      })}\n`,
    );
  });

const uploadChunkGroup = (
  input: {
    readonly client: IngestRequestClient;
    readonly importJobId: string;
    readonly plan: StreamIngestPlan;
    readonly chunkDelayMs: number;
  },
  group: readonly { chunk: IngestBatch; index: number }[],
) =>
  Effect.gen(function* () {
    const requestBody = bulkUploadRequestBody(input.importJobId, input.plan, group);
    assertJsonBudget(
      requestBody,
      MAX_BULK_UPLOAD_BODY_BYTES,
      `bulk upload group ending at chunk ${group.at(-1)?.index ?? 0}`,
    );
    yield* input.client({
      method: "POST",
      path: QuasarApiPaths.ingestJobChunksBulk,
      body: requestBody,
      responseSchema: Schema.Unknown,
    });
    if (group.at(-1)?.index !== input.plan.expectedChunkCount - 1 && input.chunkDelayMs > 0) {
      yield* Effect.sleep(Duration.millis(input.chunkDelayMs));
    }
  });

async function* streamChunkBatches(
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
): AsyncGenerator<IngestBatch> {
  for await (const batch of streamIngestBatches(streamOptions)) {
    for (const chunk of chunkIngestBatch(batch, chunkOptions)) {
      yield chunk;
    }
  }
}

const emptyIngestManifest = (
  machine: StreamIngestOptions["machine"],
  generatedAt: string,
): IngestManifestDraft => ({
  protocolVersion: "quasar.ingest-manifest/v1",
  machine,
  sourceRoots: [],
  sessions: [],
  diagnostics: [],
  generatedAt,
  sessionCount: 0,
  eventCount: 0,
  toolCallCount: 0,
  contentBlockCount: 0,
  sessionEdgeCount: 0,
  usageRecordCount: 0,
  artifactCount: 0,
});

const mergeManifest = (target: IngestManifestDraft, batch: IngestManifest) => {
  target.sourceRoots.push(...batch.sourceRoots);
  target.sessions.push(...batch.sessions);
  target.diagnostics.push(...batch.diagnostics);
  target.sessionCount += batch.sessionCount;
  target.eventCount += batch.eventCount;
  target.toolCallCount += batch.toolCallCount;
  target.contentBlockCount += batch.contentBlockCount;
  target.sessionEdgeCount += batch.sessionEdgeCount;
  target.usageRecordCount += batch.usageRecordCount;
  target.artifactCount += batch.artifactCount;
};

const summaryFromManifest = (manifest: IngestManifest) => ({
  machine: manifest.machine,
  generatedAt: manifest.generatedAt,
  sourceRootCount: manifest.sourceRoots.length,
  sessionCount: manifest.sessionCount,
  eventCount: manifest.eventCount,
  toolCallCount: manifest.toolCallCount,
  contentBlockCount: manifest.contentBlockCount,
  sessionEdgeCount: manifest.sessionEdgeCount,
  usageRecordCount: manifest.usageRecordCount,
  artifactCount: manifest.artifactCount,
  diagnostics: manifest.diagnostics,
});

const streamedIngestJobIdempotencyKey = (
  manifest: IngestManifest,
  chunkPayloadHashes: readonly string[],
) =>
  `import-job:${stableJsonHash([
    STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
    SESSION_INTELLIGENCE_CONTRACT_VERSION,
    manifestIdentityFromManifest(manifest),
    chunkPayloadHashes.map((hash, sequence) => [sequence, hash]),
  ])}`;

const manifestIdentityFromManifest = (manifest: IngestManifest) => ({
  ...manifest,
  generatedAt: undefined,
  sourceRoots: manifest.sourceRoots.map(sourceRootIdentity),
});

const sourceRootIdentity = (root: IngestManifest["sourceRoots"][number]) => ({
  ...root,
  discoveredAt: undefined,
});

const sourceManifestKey = (entry: SourceManifestEntry) => `${entry.role}:${entry.path}`;

const sortedSourceManifestEntries = (entries: Iterable<SourceManifestEntry>) =>
  [...entries].sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );

const bulkUploadRequestBody = (
  importJobId: string,
  plan: StreamIngestPlan,
  group: readonly { chunk: IngestBatch; index: number }[],
) => ({
  importJobId,
  expectedChunkCount: plan.expectedChunkCount,
  scheduleWorker: false,
  chunks: group.map(({ chunk, index }) => ({
    batch: chunk,
    sequence: index,
    idempotencyKey: ingestChunkIdempotencyKey(
      importJobId,
      index,
      expectedChunkPayloadHash(plan, index),
    ),
    completeJob: index === plan.expectedChunkCount - 1,
  })),
});

const validateChunkPayloads = (chunks: readonly IngestBatch[]) => {
  for (let index = 0; index < chunks.length; index += 1) {
    assertJsonBudget(
      chunks[index],
      MAX_UPLOAD_CHUNK_BATCH_BYTES,
      `chunk ${index}`,
    );
  }
};

const assertJsonBudget = (value: unknown, maxBytes: number, label: string) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; maximum is ${maxBytes} bytes.`);
  }
};

export const ingestJobIdempotencyKey = (
  batch: IngestBatch,
  chunks: readonly IngestBatch[],
) =>
  streamedIngestJobIdempotencyKey(
    manifestFromBatch(batch),
    chunks.map(ingestBatchPayloadHash),
  );

export const ingestBatchPayloadHash = (batch: IngestBatch) =>
  stableCanonicalJsonHash([SESSION_INTELLIGENCE_CONTRACT_VERSION, batchPayloadIdentity(batch)]);

export const ingestChunkIdempotencyKey = (
  importJobId: string,
  sequence: number,
  payloadHash: string,
) =>
  `import-chunk:${stableWideHash(
    JSON.stringify([
      STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
      SESSION_INTELLIGENCE_CONTRACT_VERSION,
      importJobId,
      sequence,
      payloadHash,
    ]),
  )}`;

const expectedChunkPayloadHash = (plan: StreamIngestPlan, index: number) => {
  const payloadHash = plan.chunkPayloadHashes[index];
  if (payloadHash === undefined) {
    throw new Error(`missing planned ingest chunk hash for sequence ${index}`);
  }
  return payloadHash;
};

const batchPayloadIdentity = (batch: IngestBatch) => ({
  ...batch,
  generatedAt: undefined,
  sourceRoots: batch.sourceRoots.map(sourceRootIdentity),
});

const envPositiveInteger = (name: string, fallback: number) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
};

const envOptionalPositiveInteger = (name: string) => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

export const chunkIngestBatch = (
  batch: IngestBatch,
  options: ChunkOptions = {},
): IngestBatch[] => {
  const chunks: IngestBatch[] = [];
  const chunkOptions = normalizeChunkOptions(options);
  for (const session of batch.sessions) {
    const sessionChunks = chunkSession(session, chunkOptions);
    for (const sessionChunk of sessionChunks) {
      const chunk = { ...batch, sessions: [sessionChunk] };
      chunks.push(
        jsonByteLength(chunk) > MAX_UPLOAD_CHUNK_BATCH_BYTES
          ? { ...batch, sessions: [sessionWithDeferredCleanup(sessionChunk)] }
          : chunk,
      );
    }
  }
  return chunks.length === 0 ? [{ ...batch, sessions: [] }] : chunks;
};

const normalizeChunkOptions = (
  options: ChunkOptions,
): Required<ChunkOptions> => ({
  maxEventsPerChunk: positiveInteger(
    options.maxEventsPerChunk,
    MAX_EVENTS_PER_CHUNK,
  ),
  maxOperationsPerChunk: positiveInteger(
    options.maxOperationsPerChunk,
    MAX_OPERATIONS_PER_CHUNK,
  ),
});

const positiveInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;

const nonNegativeInteger = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;

const positiveIntegerOrUndefined = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;

const chunkSession = (
  session: NormalizedSession,
  options: Required<ChunkOptions>,
): NormalizedSession[] => {
  if (
    session.events.length <= options.maxEventsPerChunk &&
    estimatedChunkOperations(session, session.events, 0) <=
      options.maxOperationsPerChunk
  ) {
    return [sessionWithExpectedIds(session)];
  }
  const chunks: NormalizedSession[] = [];
  let start = 0;
  let operations = 0;

  for (let index = 0; index < session.events.length; index += 1) {
    const event = session.events[index]!;
    const eventOperations = estimatedEventOperations(session, event);
    const eventLimitReached = index - start >= options.maxEventsPerChunk;
    const operationLimitReached =
      index > start && operations + eventOperations > options.maxOperationsPerChunk;

    if (eventLimitReached || operationLimitReached) {
      chunks.push(sessionChunk(session, start, index));
      start = index;
      operations = 0;
    }

    operations += eventOperations;
  }

  if (start < session.events.length) {
    chunks.push(sessionChunk(session, start, session.events.length));
  }
  return chunks.length === 0 ? [sessionWithExpectedIds(session)] : chunks;
};

const sessionChunk = (
  session: NormalizedSession,
  start: number,
  end: number,
) => {
  const events = session.events.slice(start, end);
  const eventIds = new Set(events.map((event) => event.id));
  const isLast = end >= session.events.length;
  return sessionWithExpectedIds(
    {
      ...session,
      events,
      toolCalls: session.toolCalls.filter((toolCall) => eventIds.has(toolCall.eventId)),
      sessionEdges: session.sessionEdges.filter((edge) =>
        edgeBelongsToChunk(edge.fromEventId, edge.toEventId, eventIds),
      ),
      usageRecords: session.usageRecords.filter((usageRecord) =>
        usageRecord.eventId === undefined || eventIds.has(usageRecord.eventId),
      ),
      artifacts: session.artifacts.filter((artifact) =>
        artifact.eventId === undefined ? start === 0 : eventIds.has(artifact.eventId),
      ),
      ...(!isLast ? { partialSession: true } : {}),
    } as NormalizedSession & { partialSession?: boolean },
    session,
  );
};

const estimatedChunkOperations = (
  session: NormalizedSession,
  events: readonly NormalizedSession["events"][number][],
  start: number,
) => {
  const eventIds = new Set(events.map((event) => event.id));
  return (
    events.length +
    events.reduce((sum, event) => sum + event.contentBlocks.length, 0) +
    session.toolCalls.filter((toolCall) => eventIds.has(toolCall.eventId)).length +
    session.sessionEdges.filter((edge) =>
      edgeBelongsToChunk(edge.fromEventId, edge.toEventId, eventIds),
    ).length +
    session.usageRecords.filter((usageRecord) =>
      usageRecord.eventId === undefined || eventIds.has(usageRecord.eventId),
    ).length +
    session.artifacts.filter((artifact) =>
      artifact.eventId === undefined ? start === 0 : eventIds.has(artifact.eventId),
    ).length
  );
};

const estimatedEventOperations = (
  session: NormalizedSession,
  event: NormalizedSession["events"][number],
) => {
  const eventIds = new Set([event.id]);
  return estimatedChunkOperations(session, [event], session.events.indexOf(event));
};

const edgeBelongsToChunk = (
  fromEventId: string | undefined,
  toEventId: string | undefined,
  eventIds: Set<string>,
) =>
  (fromEventId !== undefined && eventIds.has(fromEventId)) ||
  (toEventId !== undefined && eventIds.has(toEventId)) ||
  (fromEventId === undefined && toEventId === undefined);

const sessionWithExpectedIds = (
  session: NormalizedSession & { partialSession?: boolean },
  fullSession: NormalizedSession = session,
) => {
  if (session.partialSession === true) {
    return {
      ...session,
      eventCount: fullSession.events.length,
      toolCallCount: fullSession.toolCalls.length,
      contentBlockCount: fullSession.events.reduce((sum, event) => sum + event.contentBlocks.length, 0),
      sessionEdgeCount: fullSession.sessionEdges.length,
      usageRecordCount: fullSession.usageRecords.length,
      artifactCount: fullSession.artifacts.length,
      partialSession: true,
    } as NormalizedSession;
  }
  return {
    ...session,
    eventCount: fullSession.events.length,
    toolCallCount: fullSession.toolCalls.length,
    contentBlockCount: fullSession.events.reduce((sum, event) => sum + event.contentBlocks.length, 0),
    sessionEdgeCount: fullSession.sessionEdges.length,
    usageRecordCount: fullSession.usageRecords.length,
    artifactCount: fullSession.artifacts.length,
    expectedEventIds: fullSession.events.map((event) => event.id),
    expectedToolCallIds: fullSession.toolCalls.map((toolCall) => toolCall.id),
    expectedContentBlockIds: fullSession.events.flatMap((event) =>
      event.contentBlocks.map((block) => block.id),
    ),
    expectedSessionEdgeIds: fullSession.sessionEdges.map((edge) => edge.id),
    expectedUsageRecordIds: fullSession.usageRecords.map((usageRecord) => usageRecord.id),
    expectedArtifactIds: fullSession.artifacts.map((artifact) => artifact.id),
  } as NormalizedSession;
};

const sessionWithDeferredCleanup = (session: NormalizedSession) => {
  const {
    expectedEventIds: _expectedEventIds,
    expectedToolCallIds: _expectedToolCallIds,
    expectedContentBlockIds: _expectedContentBlockIds,
    expectedSessionEdgeIds: _expectedSessionEdgeIds,
    expectedUsageRecordIds: _expectedUsageRecordIds,
    expectedArtifactIds: _expectedArtifactIds,
    ...rest
  } = session as NormalizedSession & SessionCleanupMetadata;
  return {
    ...rest,
    deferCleanup: true,
  } as NormalizedSession;
};

type SessionCleanupMetadata = {
  readonly expectedEventIds?: readonly string[];
  readonly expectedToolCallIds?: readonly string[];
  readonly expectedContentBlockIds?: readonly string[];
  readonly expectedSessionEdgeIds?: readonly string[];
  readonly expectedUsageRecordIds?: readonly string[];
  readonly expectedArtifactIds?: readonly string[];
};

const inspectCommand = Command.make("inspect", {}, () =>
  executeJsonCommand(
    "ingest inspect",
    requestJson({
      method: "GET",
      path: "/api/import-runs",
      responseSchema: Schema.Unknown,
    }),
  ),
);

const waitCommand = Command.make("wait", { input: requiredInputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest wait",
    Effect.gen(function* () {
      const options = yield* loadJsonInput(IngestWaitInput, input);
      const pollIntervalMs = positiveInteger(options.pollIntervalMs, 2_000);
      const timeoutMs = positiveInteger(options.timeoutMs, 10 * 60_000);
      const startedAt = Date.now();
      while (true) {
        const status = yield* readImportJob(options.importJobId, requestJson, { limit: 1 });
        if (isFinalJobStatus(status.jobStatus)) return { timedOut: false, ...status };
        if (Date.now() - startedAt >= timeoutMs) return { timedOut: true, ...status };
        yield* Effect.sleep(Duration.millis(pollIntervalMs));
      }
    }),
  ),
);

const eventsCommand = Command.make("events", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest events",
    Effect.gen(function* () {
      const maybeInput = toUndefined(input);
      if (maybeInput === undefined) {
        return yield* requestJson({
          method: "GET",
          path: QuasarApiPaths.ingestJobs,
          responseSchema: Schema.Unknown,
        });
      }
      const options = yield* loadJsonInput(
        Schema.Struct({ importJobId: Schema.String }),
        maybeInput,
      );
      return yield* readImportJob(options.importJobId);
    }),
  ),
);

const isFinalJobStatus = (status: string) =>
  status === "succeeded" || status === "partial_failure" || status === "failed";

export const ingestCommand = Command.make("ingest").pipe(
  Command.withSubcommands([
    validateCommand,
    planCommand,
    runCommand,
    inspectCommand,
    waitCommand,
    eventsCommand,
  ]),
);
