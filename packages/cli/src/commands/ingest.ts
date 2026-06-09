import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  createReadStream,
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
import { createInterface } from "node:readline";

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
  providerSummariesForManifest,
  Provider as ProviderSchema,
  projectSessionIntelligenceGraphId,
  quasarHome,
  QuasarApiPaths,
  resnapshotSourceManifestEntries,
  snapshotIngestSourceManifest,
  stableCanonicalJsonHash,
  stableJsonHash,
  stableWideHash,
  stableAdapters,
  sourceRootIdentity,
  streamedIngestJobIdempotencyKey,
  STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
  streamIngestBatches,
  toConvexSafeSessionIntelligenceBatch,
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
import {
  IngestLedger,
  type IngestLedgerChunkIdentity,
  type IngestLedgerStatusChunk,
} from "./ingest-ledger";

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
  readonly chunkLedgerPath?: string;
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

const INGEST_GENERATION_SCHEMA_VERSION = "quasar.ingest-generation/v2";
const INGEST_GENERATION_IDENTITY_VERSION = "quasar.ingest-generation-identity/v5";
const INGEST_CHUNK_LEDGER_FORMAT = "quasar.ingest-chunks-jsonl/v1";
const INGEST_CHUNK_LEDGER_FILENAME = "chunks.ndjson";
const MAX_INGEST_MANIFEST_SESSION_SAMPLES = 25;
const INGEST_MEMORY_PRESSURE_GC_RSS_BYTES = 512 * 1024 * 1024;
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
    chunkPayloadFingerprint: Schema.String,
    idempotencyKey: Schema.String,
    sourceBefore: Schema.Array(SourceManifestEntrySchema),
  }),
  chunkLedger: Schema.Struct({
    format: Schema.Literal(INGEST_CHUNK_LEDGER_FORMAT),
    path: Schema.String,
    chunkCount: PersistedNonNegativeInteger,
    byteLength: PersistedNonNegativeInteger,
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
      return pathExistsAsDirectory(join(root, "sessions"));
    case "claude":
      return pathExistsAsDirectory(join(root, "projects"));
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
const ingestLedgerPath = () => join(quasarHome(), "ingest-ledger.sqlite");
const ingestGenerationChunkLedgerPath = (generationPath: string, ledgerPath: string) =>
  join(dirname(generationPath), ledgerPath);

const readPersistedIngestGeneration = (path: string, expectedGenerationId?: string) => {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const staleIdentityError = staleIngestGenerationIdentityError(raw);
    if (staleIdentityError !== undefined) throw staleIdentityError;
    const generation = Schema.decodeUnknownSync(PersistedIngestGeneration)(raw);
    assertPersistedIngestGeneration(generation, expectedGenerationId);
    return generation;
  } catch (error) {
    if (error instanceof CommandInputError) throw error;
    throw new CommandInputError({
      field: "ingestGeneration",
      message: `Failed to read ingest generation ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
};

const staleIngestGenerationIdentityError = (value: unknown) => {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const schemaVersion = record.schemaVersion;
  const generationId = typeof record.generationId === "string"
    ? record.generationId
    : "unknown";
  if (schemaVersion !== INGEST_GENERATION_SCHEMA_VERSION) {
    return typeof schemaVersion === "string" && schemaVersion.startsWith("quasar.ingest-generation/")
      ? new CommandInputError({
          field: "ingestGeneration",
          message: `Ingest generation ${generationId} uses ${schemaVersion}; current CLI requires ${INGEST_GENERATION_SCHEMA_VERSION}. Create a fresh ingest generation.`,
        })
      : undefined;
  }
  const intent = record.intent;
  if (intent === null || typeof intent !== "object") return undefined;
  const identityVersion = (intent as Record<string, unknown>).identityVersion;
  if (
    typeof identityVersion !== "string" ||
    identityVersion === INGEST_GENERATION_IDENTITY_VERSION
  ) {
    return undefined;
  }
  return new CommandInputError({
    field: "ingestGeneration",
    message: `Ingest generation ${generationId} was created for ${identityVersion}; current CLI requires ${INGEST_GENERATION_IDENTITY_VERSION}. Create a fresh ingest generation.`,
  });
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
  if (generation.chunkLedger.format !== INGEST_CHUNK_LEDGER_FORMAT) {
    throw new Error("chunk ledger format does not match the current CLI");
  }
  if (generation.plan.expectedChunkCount !== generation.chunkLedger.chunkCount) {
    throw new Error(
      "expectedChunkCount does not match the persisted chunk ledger count",
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
      const ledgerPath = join(tempDirectory, INGEST_CHUNK_LEDGER_FILENAME);
      const { plan, ledger } = yield* writeStreamedIngestLedger(
        streamOptions,
        input.chunkOptions,
        ledgerPath,
      );
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
          chunkPayloadFingerprint: plan.chunkPayloadFingerprint,
          idempotencyKey: plan.idempotencyKey,
          sourceBefore: [...plan.sourceBefore],
        },
        chunkLedger: {
          format: INGEST_CHUNK_LEDGER_FORMAT,
          path: INGEST_CHUNK_LEDGER_FILENAME,
          chunkCount: ledger.chunkCount,
          byteLength: ledger.byteLength,
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
  const chunkLedgerPath = ingestGenerationChunkLedgerPath(path, generation.chunkLedger.path);
  if (!existsSync(generation.sourceSnapshot.rootPath)) {
    throw new CommandInputError({
      field: "ingestGeneration",
      message: `Ingest generation ${generation.generationId} is missing its source snapshot at ${generation.sourceSnapshot.rootPath}.`,
    });
  }
  if (!existsSync(chunkLedgerPath)) {
    throw new CommandInputError({
      field: "ingestGeneration",
      message: `Ingest generation ${generation.generationId} is missing its chunk ledger at ${chunkLedgerPath}.`,
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
      chunkPayloadFingerprint: generation.plan.chunkPayloadFingerprint,
      idempotencyKey: generation.plan.idempotencyKey,
      sourceBefore: generation.plan.sourceBefore,
    },
    chunkLedgerPath,
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
  if (!pathExistsAsDirectory(sourceDirectory)) return undefined;
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

const pathExistsAsDirectory = (path: string) => {
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
  ledgerContext?: {
    readonly ledger: IngestLedger;
    readonly sourceIdentityKey: string;
    readonly generationId?: string;
    readonly plannedChunks: readonly IngestLedgerChunkIdentity[];
  },
) =>
  Effect.gen(function* () {
    let nextSequence = 0;
    let chunkCursor: string | undefined;
    while (nextSequence < plan.expectedChunkCount) {
      const status = yield* readImportJob(importJobId, requestClient, {
        limit: RESUME_STATUS_PAGE_LIMIT,
        chunkCursor,
      });
      if (ledgerContext !== undefined) {
        observeLedgerImportJobStatus(ledgerContext.ledger, {
          sourceIdentityKey: ledgerContext.sourceIdentityKey,
          importJobId,
          expectedChunkCount: plan.expectedChunkCount,
          generationId: ledgerContext.generationId,
          status,
          plannedChunks: ledgerContext.plannedChunks,
        });
      }
      const chunks = chunkStatusRows(status.chunks).sort(
        (left, right) => chunkSequence(left) - chunkSequence(right),
      );
      if (chunks.length === 0) return nextSequence;
      for (const chunk of chunks) {
        const sequence = chunkSequence(chunk);
        if (sequence !== nextSequence) return nextSequence;
        const planned = ledgerContext?.plannedChunks[sequence] ??
          (plan.chunkPayloadHashes === undefined
            ? undefined
            : expectedPlanChunkIdentity(importJobId, plan, sequence));
        if (planned === undefined) {
          throw new Error(
            `import job ${importJobId} has an incompatible chunk at sequence ${sequence}`,
          );
        }
        const compatibility = chunkResumeCompatibility(chunk, planned);
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

const resumeUploadedChunkCount = (input: {
  readonly job: { readonly chunkCount: number };
  readonly preUploadDrain?: DrainResult;
  readonly sourceIdentityKey: string;
  readonly importJobId: string;
  readonly generationId?: string;
  readonly plan: StreamIngestPlan;
  readonly plannedChunks: readonly IngestLedgerChunkIdentity[];
  readonly ledger: IngestLedger;
  readonly client: IngestRequestClient;
}) =>
  Effect.gen(function* () {
    if (input.job.chunkCount <= 0) return 0;
    const ledgerPrefix = input.ledger.uploadedPrefixCount({
      sourceIdentityKey: input.sourceIdentityKey,
      importJobId: input.importJobId,
      chunks: input.plannedChunks,
    });
    const serverPrefix = jobNumber(input.preUploadDrain?.status.job, "succeededPrefixCount");
    if (ledgerPrefix > 0 && serverPrefix === ledgerPrefix) return ledgerPrefix;
    return yield* safeResumeUploadedChunkCount(
      input.importJobId,
      input.plan,
      input.client,
      {
        ledger: input.ledger,
        sourceIdentityKey: input.sourceIdentityKey,
        generationId: input.generationId,
        plannedChunks: input.plannedChunks,
      },
    );
  });

const plannedChunkIdentities = (
  importJobId: string,
  plan: StreamIngestPlan,
): IngestLedgerChunkIdentity[] =>
  requiredPlanChunkPayloadHashes(plan).map((payloadHash, sequence) => ({
    sequence,
    payloadHash,
    idempotencyKey: ingestChunkIdempotencyKey(importJobId, sequence, payloadHash),
  }));

const plannedChunkIdentitiesFromLedger = (
  importJobId: string,
  chunkLedgerPath: string,
  expectedChunkCount: number,
) =>
  Effect.tryPromise({
    try: async () => {
      const identities: IngestLedgerChunkIdentity[] = [];
      for await (const item of streamChunkLedgerItems(chunkLedgerPath, expectedChunkCount)) {
        identities.push({
          sequence: item.index,
          payloadHash: item.payloadHash,
          idempotencyKey: ingestChunkIdempotencyKey(importJobId, item.index, item.payloadHash),
        });
      }
      return identities;
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

const observeLedgerImportJobStatus = (
  ledger: IngestLedger,
  input: {
    readonly sourceIdentityKey: string;
    readonly importJobId: string;
    readonly expectedChunkCount: number;
    readonly generationId?: string;
    readonly status: ImportJobStatusSnapshot;
    readonly plannedChunks: readonly IngestLedgerChunkIdentity[];
  },
) => {
  const plannedBySequence = new Map(
    input.plannedChunks.map((chunk) => [chunk.sequence, chunk]),
  );
  const chunks: IngestLedgerStatusChunk[] = chunkStatusRows(input.status.chunks).flatMap((chunk) => {
    const sequence = chunkSequence(chunk);
    const planned = Number.isFinite(sequence) ? plannedBySequence.get(sequence) : undefined;
    return [{
      sequence,
      chunkId: chunk.chunkId,
      status: chunk.status,
      payloadHash: chunk.payloadHash ?? planned?.payloadHash,
      idempotencyKey: chunk.idempotencyKey ?? planned?.idempotencyKey,
      payloadStored: chunk.payloadStored,
      error: chunk.error,
    }];
  });
  ledger.observeStatus({
    sourceIdentityKey: input.sourceIdentityKey,
    importJobId: input.importJobId,
    expectedChunkCount: input.expectedChunkCount,
    generationId: input.generationId,
    status: input.status.jobStatus,
    now: ledgerTimestamp(),
    chunks,
  });
};

const ledgerTimestamp = () => new Date().toISOString();

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

const expectedPlanChunkIdentity = (
  importJobId: string,
  plan: StreamIngestPlan,
  sequence: number,
): IngestLedgerChunkIdentity => {
  const payloadHash = expectedChunkPayloadHash(plan, sequence);
  return {
    sequence,
    payloadHash,
    idempotencyKey: ingestChunkIdempotencyKey(importJobId, sequence, payloadHash),
  };
};

const chunkResumeCompatibility = (
  chunk: Record<string, unknown>,
  planned: IngestLedgerChunkIdentity,
): "safe" | "repair" | "incompatible" => {
  if (chunk.idempotencyKey !== planned.idempotencyKey) {
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
  const terminal = jobNumber(job, "terminalChunkCount") ??
    ((jobNumber(job, "succeededChunkCount") ?? 0) + (jobNumber(job, "failedChunkCount") ?? 0));
  return {
    inFlightChunkCount: Math.max(0, uploaded - terminal),
    uploadedChunkCount: uploaded,
    terminalChunkCount: terminal,
  };
};

const importJobUploadSummary = (status: ImportJobStatusSnapshot) => {
  const job = status.job;
  const expected = jobNumber(job, "expectedChunkCount");
  const uploaded = jobNumber(job, "uploadedChunkCount") ?? jobNumber(job, "chunkCount") ?? 0;
  const terminal = jobNumber(job, "terminalChunkCount") ??
    ((jobNumber(job, "succeededChunkCount") ?? 0) + (jobNumber(job, "failedChunkCount") ?? 0));
  const inFlight = jobNumber(job, "inFlightChunkCount") ?? Math.max(0, uploaded - terminal);
  const missing = expected === undefined ? undefined : Math.max(0, expected - uploaded);
  const uploadComplete = expected !== undefined && uploaded >= expected;
  return {
    expectedChunkCount: expected,
    uploadedChunkCount: uploaded,
    terminalChunkCount: terminal,
    inFlightChunkCount: inFlight,
    uploadComplete,
    uploadIncomplete: expected !== undefined && !uploadComplete,
    ...(missing !== undefined ? { missingUploadChunkCount: missing } : {}),
  };
};

export const isIdleUploadIncompleteImportJob = (status: {
  readonly job: unknown;
  readonly jobStatus: string;
}) => {
  if (isFinalJobStatus(status.jobStatus)) return false;
  const uploadStatus = importJobUploadSummary(status as ImportJobStatusSnapshot);
  return uploadStatus.uploadIncomplete && uploadStatus.inFlightChunkCount <= 0;
};

const jobNumber = (job: unknown, key: string) => {
  if (job === null || typeof job !== "object") return undefined;
  const value = (job as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};

export const sanitizeInspectionBatch = (batch: IngestBatch): IngestBatch =>
  sanitizeIngestBatchForTransport(toConvexSafeSessionIntelligenceBatch(batch));

const validateCommand = Command.make("validate", { input: inputArg }, ({ input }) =>
  executeJsonCommand(
    "ingest validate",
    buildBatchWithSourceSnapshotEffect(toUndefined(input)).pipe(
      Effect.map(({ before, batch: rawBatch }) => {
        const batch = sanitizeInspectionBatch(rawBatch);
        const after = snapshotIngestSourceManifest(rawBatch);
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
        providerSummaries: plan.manifest.providerSummaries ?? [],
        sessionSampleLimit: MAX_INGEST_MANIFEST_SESSION_SAMPLES,
        sessionSamplesTruncated:
          plan.manifest.sessionCount > plan.manifest.sessions.length,
        sessionSamples: plan.manifest.sessions.map((session) => ({
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
  readonly ledger: IngestLedger;
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
        idempotencyKey: plan.idempotencyKey,
        chunkPayloadFingerprint: plan.chunkPayloadFingerprint,
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
    const sourceIdentityKey = plan.idempotencyKey;
    const plannedChunks = input.prepared.chunkLedgerPath === undefined
      ? plannedChunkIdentities(job.importJobId, plan)
      : yield* plannedChunkIdentitiesFromLedger(
          job.importJobId,
          input.prepared.chunkLedgerPath,
          plan.expectedChunkCount,
        );
    input.ledger.recordPlan({
      sourceIdentityKey,
      importJobId: job.importJobId,
      expectedChunkCount: plan.expectedChunkCount,
      generationId: input.prepared.generation?.generationId,
      status: job.status,
      now: ledgerTimestamp(),
      chunks: plannedChunks,
    });
    const drainOptions = drainOptionsFromOptions(input.options);
    const preUploadDrain = job.chunkCount <= 0
      ? undefined
      : yield* waitForImportJobDrain(job.importJobId, input.client, drainOptions, {
          scheduleWorker: true,
          alreadyScheduled: false,
        });
    if (preUploadDrain !== undefined) {
      observeLedgerImportJobStatus(input.ledger, {
        sourceIdentityKey,
        importJobId: job.importJobId,
        expectedChunkCount: plan.expectedChunkCount,
        generationId: input.prepared.generation?.generationId,
        status: preUploadDrain.status,
        plannedChunks,
      });
    }
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
      chunkLedgerPath: input.prepared.chunkLedgerPath,
      client: input.client,
      importJobId: job.importJobId,
      sourceIdentityKey,
      generationId: input.prepared.generation?.generationId,
      ledger: input.ledger,
      plannedChunks,
      resumeUploadedChunkCount: yield* resumeUploadedChunkCount({
        job,
        preUploadDrain,
        sourceIdentityKey,
        importJobId: job.importJobId,
        generationId: input.prepared.generation?.generationId,
        plan,
        plannedChunks,
        ledger: input.ledger,
        client: input.client,
      }),
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
    observeLedgerImportJobStatus(input.ledger, {
      sourceIdentityKey,
      importJobId: job.importJobId,
      expectedChunkCount: plan.expectedChunkCount,
      generationId: input.prepared.generation?.generationId,
      status,
      plannedChunks,
    });
    const ledger = input.ledger.summary({
      sourceIdentityKey,
      importJobId: job.importJobId,
      chunks: plannedChunks,
    });
    const after = resnapshotSourceManifestEntries(plan.sourceBefore);
    const uploadStatus = importJobUploadSummary(status);
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
      uploadStatus,
      drain: {
        ...(preUploadDrain !== undefined ? { beforeUpload: drainPublicResult(preUploadDrain) } : {}),
        ...(postUploadDrain !== undefined ? { afterUpload: drainPublicResult(postUploadDrain) } : {}),
      },
      status,
      ledger,
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
      const batch = sanitizeInspectionBatch(rawBatch);
      const after = snapshotIngestSourceManifest(rawBatch);
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
    const ledger = new IngestLedger(ingestLedgerPath());
    try {
      return yield* runPreparedIngest({
        options,
        client,
        machine,
        generatedAt,
        chunkOptions,
        prepared,
        ledger,
      });
    } finally {
      ledger.close();
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
  readonly chunkPayloadHashes?: readonly string[];
  readonly chunkPayloadFingerprint: string;
  readonly idempotencyKey: string;
  readonly sourceBefore: readonly SourceManifestEntry[];
};

type IngestProviderSummary = NonNullable<IngestManifest["providerSummaries"]>[number];

type ChunkUploadItem = {
  readonly chunk: IngestBatch;
  readonly index: number;
  readonly payloadHash: string;
};

type IngestManifestDraft = {
  protocolVersion: "quasar.ingest-manifest/v1";
  machine: IngestManifest["machine"];
  sourceRoots: IngestManifest["sourceRoots"][number][];
  sessions: IngestManifest["sessions"][number][];
  providerSummaries: IngestProviderSummary[];
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
      let chunkPayloadFingerprint = emptyChunkPayloadFingerprint();
      for await (const rawBatch of streamIngestBatches(streamOptions)) {
        const batch = toConvexSafeSessionIntelligenceBatch(rawBatch);
        mergeManifest(manifest, manifestFromBatch(batch));
        for (const entry of snapshotIngestSourceManifest(rawBatch)) {
          sourceBefore.set(sourceManifestKey(entry), entry);
        }
        for (const chunk of streamChunkedIngestBatch(batch, chunkOptions)) {
          assertJsonBudget(
            chunk,
            MAX_UPLOAD_CHUNK_BATCH_BYTES,
            `chunk ${chunkPayloadHashes.length}`,
          );
          const payloadHash = ingestBatchPayloadHash(chunk);
          chunkPayloadHashes.push(payloadHash);
          chunkPayloadFingerprint = updateChunkPayloadFingerprint(
            chunkPayloadFingerprint,
            chunkPayloadHashes.length - 1,
            payloadHash,
          );
        }
        releaseIngestMemoryPressure();
      }
      const plannedManifest: IngestManifest = manifest;
      return {
        manifest: plannedManifest,
        expectedChunkCount: chunkPayloadHashes.length,
        chunkPayloadHashes,
        chunkPayloadFingerprint,
        idempotencyKey: streamedIngestJobIdempotencyKey(plannedManifest, chunkPayloadFingerprint),
        sourceBefore: sortedSourceManifestEntries(sourceBefore.values()),
      };
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

const writeStreamedIngestLedger = (
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
  ledgerPath: string,
) =>
  Effect.tryPromise({
    try: async () => {
      writeFileSync(ledgerPath, "", { encoding: "utf8", mode: 0o600 });
      const manifest = emptyIngestManifest(streamOptions.machine, streamOptions.generatedAt);
      const sourceBefore = new Map<string, SourceManifestEntry>();
      let chunkPayloadFingerprint = emptyChunkPayloadFingerprint();
      let chunkCount = 0;
      let byteLength = 0;
      for await (const rawBatch of streamIngestBatches(streamOptions)) {
        const batch = toConvexSafeSessionIntelligenceBatch(rawBatch);
        mergeManifest(manifest, manifestFromBatch(batch));
        for (const entry of snapshotIngestSourceManifest(rawBatch)) {
          sourceBefore.set(sourceManifestKey(entry), entry);
        }
        for (const chunk of streamChunkedIngestBatch(batch, chunkOptions)) {
          assertJsonBudget(chunk, MAX_UPLOAD_CHUNK_BATCH_BYTES, `chunk ${chunkCount}`);
          const payloadHash = ingestBatchPayloadHash(chunk);
          const payloadBytes = jsonByteLength(chunk);
          chunkPayloadFingerprint = updateChunkPayloadFingerprint(
            chunkPayloadFingerprint,
            chunkCount,
            payloadHash,
          );
          const line = `${JSON.stringify({
            format: INGEST_CHUNK_LEDGER_FORMAT,
            sequence: chunkCount,
            payloadHash,
            payloadBytes,
            batch: chunk,
          })}\n`;
          appendFileSync(ledgerPath, line, { encoding: "utf8" });
          byteLength += Buffer.byteLength(line, "utf8");
          chunkCount += 1;
        }
        releaseIngestMemoryPressure();
      }
      const plannedManifest: IngestManifest = manifest;
      const plan: StreamIngestPlan = {
        manifest: plannedManifest,
        expectedChunkCount: chunkCount,
        chunkPayloadFingerprint,
        idempotencyKey: streamedIngestJobIdempotencyKey(plannedManifest, chunkPayloadFingerprint),
        sourceBefore: sortedSourceManifestEntries(sourceBefore.values()),
      };
      return { plan, ledger: { chunkCount, byteLength } };
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  });

type UploadStreamedIngestInput = {
  readonly streamOptions: StreamIngestOptions;
  readonly chunkOptions: Required<ChunkOptions>;
  readonly plan: StreamIngestPlan;
  readonly chunkLedgerPath?: string;
  readonly client: IngestRequestClient;
  readonly importJobId: string;
  readonly sourceIdentityKey: string;
  readonly generationId?: string;
  readonly ledger: IngestLedger;
  readonly plannedChunks: readonly IngestLedgerChunkIdentity[];
  readonly resumeUploadedChunkCount: number;
  readonly uploadGroupSize: number;
  readonly maxUploadChunksPerRun?: number;
  readonly chunkDelayMs: number;
  readonly progress: UploadProgressOptions;
};

type UploadProgressState = {
  readonly uploadedThisRunCount: number;
  readonly uploadedChunkCount: number;
  readonly uploadGroupCount: number;
};

const uploadStreamedIngest = (input: UploadStreamedIngestInput) =>
  Effect.gen(function* () {
    const iterator = (
      input.chunkLedgerPath === undefined
        ? streamChunkItems(input.streamOptions, input.chunkOptions)
        : streamChunkLedgerItems(input.chunkLedgerPath, input.plan.expectedChunkCount)
    )[Symbol.asyncIterator]();
    let group: ChunkUploadItem[] = [];
    const skippedUploadedChunkCount = Math.min(
      Math.max(0, input.resumeUploadedChunkCount),
      input.plan.expectedChunkCount,
    );
    let progressState: UploadProgressState = {
      uploadedThisRunCount: 0,
      uploadedChunkCount: skippedUploadedChunkCount,
      uploadGroupCount: 0,
    };
    let uploadStoppedEarly = false;
    let iteratedChunkCount = 0;
    yield* emitUploadProgress(input, progressState.uploadedChunkCount, progressState.uploadGroupCount);
    if (skippedUploadedChunkCount >= input.plan.expectedChunkCount) {
      return {
        uploadedChunkCount: progressState.uploadedChunkCount,
        uploadedThisRunCount: progressState.uploadedThisRunCount,
        skippedUploadedChunkCount,
        uploadGroupCount: progressState.uploadGroupCount,
        uploadComplete: true,
        uploadStoppedEarly: false,
      };
    }
    while (true) {
      if (
        input.maxUploadChunksPerRun !== undefined &&
        progressState.uploadedThisRunCount + group.length >= input.maxUploadChunksPerRun
      ) {
        uploadStoppedEarly = true;
        break;
      }
      const next = yield* Effect.tryPromise({
        try: () => iterator.next(),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
      if (next.done === true) break;
      const item = next.value;
      const { chunk, index } = item;
      iteratedChunkCount = index + 1;
      if (index < skippedUploadedChunkCount) {
        continue;
      }
      assertJsonBudget(chunk, MAX_UPLOAD_CHUNK_BATCH_BYTES, `chunk ${index}`);
      const uploadItem = validatedUploadItem(input, item);
      const candidate = [...group, uploadItem];
      const nextBytes = jsonByteLength(
        bulkUploadRequestBody(input.importJobId, input.plan, candidate),
      );
      if (
        group.length > 0 &&
        (group.length >= input.uploadGroupSize || nextBytes > MAX_BULK_UPLOAD_BODY_BYTES)
      ) {
        progressState = yield* flushUploadGroup(input, group, progressState);
        group = [uploadItem];
      } else {
        group = candidate;
      }
    }
    if (group.length > 0) {
      progressState = yield* flushUploadGroup(input, group, progressState, {
        force: uploadStoppedEarly,
      });
    }
    if (!uploadStoppedEarly && iteratedChunkCount !== input.plan.expectedChunkCount) {
      throw new Error(
        `ingest planned ${input.plan.expectedChunkCount} chunks but uploaded ${iteratedChunkCount}`,
      );
    }
    return {
      uploadedChunkCount: progressState.uploadedChunkCount,
      uploadedThisRunCount: progressState.uploadedThisRunCount,
      skippedUploadedChunkCount,
      uploadGroupCount: progressState.uploadGroupCount,
      uploadComplete: progressState.uploadedChunkCount >= input.plan.expectedChunkCount,
      uploadStoppedEarly,
    };
  });

const validatedUploadItem = (
  input: UploadStreamedIngestInput,
  item: ChunkUploadItem,
): ChunkUploadItem => {
  const actualHash = ingestBatchPayloadHash(item.chunk);
  const expectedHash = input.chunkLedgerPath === undefined
    ? requiredPlanChunkPayloadHashes(input.plan)[item.index]
    : item.payloadHash;
  if (expectedHash === undefined || expectedHash !== actualHash) {
    throw new Error(`ingest source changed between planning and upload at chunk ${item.index}`);
  }
  return { ...item, payloadHash: expectedHash };
};

const flushUploadGroup = (
  input: UploadStreamedIngestInput,
  group: readonly ChunkUploadItem[],
  state: UploadProgressState,
  progressOptions: { readonly force?: boolean } = {},
) =>
  Effect.gen(function* () {
    yield* uploadChunkGroup(input, group);
    const next = {
      uploadedThisRunCount: state.uploadedThisRunCount + group.length,
      uploadedChunkCount: state.uploadedChunkCount + group.length,
      uploadGroupCount: state.uploadGroupCount + 1,
    };
    yield* emitUploadProgress(input, next.uploadedChunkCount, next.uploadGroupCount, progressOptions);
    return next;
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
    readonly sourceIdentityKey: string;
    readonly generationId?: string;
    readonly ledger: IngestLedger;
    readonly plan: StreamIngestPlan;
    readonly plannedChunks: readonly IngestLedgerChunkIdentity[];
    readonly chunkDelayMs: number;
  },
  group: readonly ChunkUploadItem[],
) =>
  Effect.gen(function* () {
    const requestBody = bulkUploadRequestBody(input.importJobId, input.plan, group);
    assertJsonBudget(
      requestBody,
      MAX_BULK_UPLOAD_BODY_BYTES,
      `bulk upload group ending at chunk ${group.at(-1)?.index ?? 0}`,
    );
    const ledgerChunks = ledgerChunkIdentitiesForGroup(input.plannedChunks, group);
    input.ledger.markUploading({
      sourceIdentityKey: input.sourceIdentityKey,
      importJobId: input.importJobId,
      chunks: ledgerChunks,
      now: ledgerTimestamp(),
    });
    const response = yield* input.client({
      method: "POST",
      path: QuasarApiPaths.ingestJobChunksBulk,
      body: requestBody,
      responseSchema: Schema.Unknown,
    });
    const now = ledgerTimestamp();
    input.ledger.markAcknowledged({
      sourceIdentityKey: input.sourceIdentityKey,
      importJobId: input.importJobId,
      chunks: ledgerChunks,
      now,
    });
    input.ledger.observeStatus({
      sourceIdentityKey: input.sourceIdentityKey,
      importJobId: input.importJobId,
      expectedChunkCount: input.plan.expectedChunkCount,
      generationId: input.generationId,
      status: "running",
      now,
      chunks: bulkResponseStatusChunks(response, ledgerChunks),
    });
    if (group.at(-1)?.index !== input.plan.expectedChunkCount - 1 && input.chunkDelayMs > 0) {
      yield* Effect.sleep(Duration.millis(input.chunkDelayMs));
    }
  });

async function* streamChunkItems(
  streamOptions: StreamIngestOptions,
  chunkOptions: Required<ChunkOptions>,
): AsyncGenerator<ChunkUploadItem> {
  let index = 0;
  for await (const rawBatch of streamIngestBatches(streamOptions)) {
    const batch = toConvexSafeSessionIntelligenceBatch(rawBatch);
    for (const chunk of streamChunkedIngestBatch(batch, chunkOptions)) {
      yield { chunk, index, payloadHash: ingestBatchPayloadHash(chunk) };
      index += 1;
    }
    releaseIngestMemoryPressure();
  }
}

async function* streamChunkLedgerItems(
  chunkLedgerPath: string,
  expectedChunkCount: number,
): AsyncGenerator<ChunkUploadItem> {
  const lines = createInterface({
    input: createReadStream(chunkLedgerPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let index = 0;
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.format !== INGEST_CHUNK_LEDGER_FORMAT) {
      throw new Error(`chunk ledger ${chunkLedgerPath} has an unsupported row format`);
    }
    if (record.sequence !== index) {
      throw new Error(`chunk ledger ${chunkLedgerPath} is missing sequence ${index}`);
    }
    if (typeof record.payloadHash !== "string" || record.payloadHash.length === 0) {
      throw new Error(`chunk ledger ${chunkLedgerPath} is missing payloadHash for sequence ${index}`);
    }
    const chunk = record.batch as IngestBatch;
    assertJsonBudget(chunk, MAX_UPLOAD_CHUNK_BATCH_BYTES, `chunk ${index}`);
    const actualHash = ingestBatchPayloadHash(chunk);
    if (record.payloadHash !== actualHash) {
      throw new Error(`chunk ledger ${chunkLedgerPath} payload hash changed at sequence ${index}`);
    }
    yield { chunk, index, payloadHash: record.payloadHash };
    index += 1;
  }
  if (index !== expectedChunkCount) {
    throw new Error(
      `chunk ledger ${chunkLedgerPath} has ${index} chunk(s); expected ${expectedChunkCount}`,
    );
  }
}

const emptyIngestManifest = (
  machine: StreamIngestOptions["machine"],
  generatedAt: string,
): IngestManifestDraft => {
  const manifest = manifestFromBatch(
    toConvexSafeSessionIntelligenceBatch({
      protocolVersion: "quasar.ingest/v1",
      machine,
      sourceRoots: [],
      sessions: [],
      diagnostics: [],
      generatedAt,
    }),
  );
  return {
    ...manifest,
    sourceRoots: [...manifest.sourceRoots],
    sessions: [...manifest.sessions],
    providerSummaries: [...(manifest.providerSummaries ?? [])],
    diagnostics: [...manifest.diagnostics],
  };
};

const mergeManifest = (target: IngestManifestDraft, batch: IngestManifest) => {
  target.sourceRoots.push(...batch.sourceRoots);
  const remainingSessionSampleSlots = Math.max(
    0,
    MAX_INGEST_MANIFEST_SESSION_SAMPLES - target.sessions.length,
  );
  if (remainingSessionSampleSlots > 0) {
    target.sessions.push(...batch.sessions.slice(0, remainingSessionSampleSlots));
  }
  mergeProviderSummaries(target.providerSummaries, batch);
  target.diagnostics.push(...batch.diagnostics);
  target.sessionCount += batch.sessionCount;
  target.eventCount += batch.eventCount;
  target.toolCallCount += batch.toolCallCount;
  target.contentBlockCount += batch.contentBlockCount;
  target.sessionEdgeCount += batch.sessionEdgeCount;
  target.usageRecordCount += batch.usageRecordCount;
  target.artifactCount += batch.artifactCount;
};

const mergeProviderSummaries = (
  target: IngestProviderSummary[],
  batch: IngestManifest,
) => {
  const byProvider = new Map(target.map((summary) => [summary.provider, summary]));
  for (const summary of providerSummariesForManifest(batch)) {
    const current = byProvider.get(summary.provider) ?? {
      provider: summary.provider,
      sessionCount: 0,
      eventCount: 0,
      toolCallCount: 0,
      contentBlockCount: 0,
      sessionEdgeCount: 0,
      usageRecordCount: 0,
      artifactCount: 0,
    };
    byProvider.set(summary.provider, {
      provider: summary.provider,
      sessionCount: current.sessionCount + summary.sessionCount,
      eventCount: current.eventCount + summary.eventCount,
      toolCallCount: current.toolCallCount + summary.toolCallCount,
      contentBlockCount: current.contentBlockCount + summary.contentBlockCount,
      sessionEdgeCount: current.sessionEdgeCount + summary.sessionEdgeCount,
      usageRecordCount: current.usageRecordCount + summary.usageRecordCount,
      artifactCount: current.artifactCount + summary.artifactCount,
    });
  }
  target.splice(
    0,
    target.length,
    ...[...byProvider.values()].sort((left, right) =>
      left.provider.localeCompare(right.provider),
    ),
  );
};

const summaryFromManifest = (manifest: IngestManifest) => ({
  machine: manifest.machine,
  generatedAt: manifest.generatedAt,
  sourceRootCount: manifest.sourceRoots.length,
  providerSummaries: manifest.providerSummaries ?? [],
  sessionCount: manifest.sessionCount,
  eventCount: manifest.eventCount,
  toolCallCount: manifest.toolCallCount,
  contentBlockCount: manifest.contentBlockCount,
  sessionEdgeCount: manifest.sessionEdgeCount,
  usageRecordCount: manifest.usageRecordCount,
  artifactCount: manifest.artifactCount,
  diagnostics: manifest.diagnostics,
});

const emptyChunkPayloadFingerprint = () =>
  stableWideHash(JSON.stringify([
    STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
    SESSION_INTELLIGENCE_CONTRACT_VERSION,
    "chunk-payload-fingerprint/v1",
  ]));

const updateChunkPayloadFingerprint = (
  previous: string,
  sequence: number,
  payloadHash: string,
) =>
  stableWideHash(JSON.stringify([
    STREAM_INGEST_UPLOAD_IDENTITY_VERSION,
    SESSION_INTELLIGENCE_CONTRACT_VERSION,
    previous,
    sequence,
    payloadHash,
  ]));

const sourceManifestKey = (entry: SourceManifestEntry) => `${entry.role}:${entry.path}`;

const sortedSourceManifestEntries = (entries: Iterable<SourceManifestEntry>) =>
  [...entries].sort((left, right) =>
    `${left.role}:${left.path}`.localeCompare(`${right.role}:${right.path}`),
  );

const bulkUploadRequestBody = (
  importJobId: string,
  plan: StreamIngestPlan,
  group: readonly ChunkUploadItem[],
) => ({
  importJobId,
  expectedChunkCount: plan.expectedChunkCount,
  scheduleWorker: false,
  chunks: group.map(({ chunk, index, payloadHash }) => ({
    batch: chunk,
    sequence: index,
    idempotencyKey: ingestChunkIdempotencyKey(
      importJobId,
      index,
      payloadHash,
    ),
    completeJob: index === plan.expectedChunkCount - 1,
  })),
});

const ledgerChunkIdentitiesForGroup = (
  plannedChunks: readonly IngestLedgerChunkIdentity[],
  group: readonly { index: number }[],
) =>
  group.map(({ index }) => {
    const planned = plannedChunks[index];
    if (planned === undefined) {
      throw new Error(`missing planned ingest chunk ledger identity for sequence ${index}`);
    }
    return planned;
  });

const bulkResponseStatusChunks = (
  response: unknown,
  fallback: readonly IngestLedgerChunkIdentity[],
): IngestLedgerStatusChunk[] => {
  if (response === null || typeof response !== "object") return [...fallback];
  const results = (response as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [...fallback];
  return results.flatMap((result, index) => {
    const fallbackChunk = fallback[index];
    if (fallbackChunk === undefined) return [];
    if (result === null || typeof result !== "object") return [];
    const record = result as Record<string, unknown>;
    const chunkId = typeof record.chunkId === "string" ? record.chunkId : undefined;
    return [{
      sequence: fallbackChunk.sequence,
      chunkId,
      status: record.status,
      payloadHash: fallbackChunk.payloadHash,
      idempotencyKey: fallbackChunk.idempotencyKey,
      payloadStored: true,
    }];
  });
};

const assertJsonBudget = (value: unknown, maxBytes: number, label: string) => {
  const bytes = jsonByteLength(value);
  if (bytes > maxBytes) {
    throw new Error(`${label} is ${bytes} bytes; maximum is ${maxBytes} bytes.`);
  }
};

const releaseIngestMemoryPressure = () => {
  if (process.memoryUsage().rss < INGEST_MEMORY_PRESSURE_GC_RSS_BYTES) return;
  const maybeBun = globalThis as typeof globalThis & {
    readonly Bun?: { readonly gc?: (force?: boolean) => void };
  };
  maybeBun.Bun?.gc?.(true);
};

export const ingestJobIdempotencyKey = (
  batch: IngestBatch,
  chunks: readonly IngestBatch[],
) =>
  streamedIngestJobIdempotencyKey(
    manifestFromBatch(batch),
    chunkPayloadFingerprintFromHashes(chunks.map(ingestBatchPayloadHash)),
  );

const chunkPayloadFingerprintFromHashes = (hashes: readonly string[]) =>
  hashes.reduce(
    (fingerprint, payloadHash, sequence) =>
      updateChunkPayloadFingerprint(fingerprint, sequence, payloadHash),
    emptyChunkPayloadFingerprint(),
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
  const payloadHash = requiredPlanChunkPayloadHashes(plan)[index];
  if (payloadHash === undefined) {
    throw new Error(`missing planned ingest chunk hash for sequence ${index}`);
  }
  return payloadHash;
};

const requiredPlanChunkPayloadHashes = (plan: StreamIngestPlan) => {
  if (plan.chunkPayloadHashes === undefined) {
    throw new Error("planned ingest chunk hashes are unavailable; use the durable chunk ledger");
  }
  return plan.chunkPayloadHashes;
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
): IngestBatch[] => [...streamChunkedIngestBatch(batch, options)];

const streamChunkedIngestBatch = function* (
  batch: IngestBatch,
  options: ChunkOptions = {},
): Generator<IngestBatch> {
  const chunkOptions = normalizeChunkOptions(options);
  let yielded = false;
  for (const session of batch.sessions) {
    for (const range of chunkSessionRanges(session, chunkOptions)) {
      for (const chunk of uploadSizedSessionChunks(batch, session, range.start, range.end)) {
        yielded = true;
        yield chunk;
      }
    }
  }
  if (!yielded) yield sanitizeUploadChunk({ ...batch, sessions: [] });
};

const uploadSizedSessionChunks = function* (
  batch: IngestBatch,
  session: NormalizedSession,
  start: number,
  end: number,
): Generator<IngestBatch> {
  const sessionPiece = sessionChunk(session, start, end);
  const chunk = sanitizeUploadChunk({ ...batch, sessions: [sessionPiece] });
  if (jsonByteLength(chunk) <= MAX_UPLOAD_CHUNK_BATCH_BYTES) {
    yield chunk;
    return;
  }

  const deferredChunk = sanitizeUploadChunk({
    ...batch,
    sessions: [sessionWithDeferredCleanup(sessionPiece)],
  });
  if (jsonByteLength(deferredChunk) <= MAX_UPLOAD_CHUNK_BATCH_BYTES || end - start <= 1) {
    yield deferredChunk;
    return;
  }

  const midpoint = start + Math.max(1, Math.floor((end - start) / 2));
  yield* uploadSizedSessionChunks(batch, session, start, midpoint);
  yield* uploadSizedSessionChunks(batch, session, midpoint, end);
};

const MAX_UPLOAD_SANITIZE_PASSES = 4;

export const sanitizeUploadChunk = (chunk: IngestBatch): IngestBatch => {
  let current = sanitizeUploadChunkOnce(chunk);
  for (let pass = 1; pass < MAX_UPLOAD_SANITIZE_PASSES; pass += 1) {
    const next = sanitizeUploadChunkOnce(current);
    if (ingestBatchPayloadHash(next) === ingestBatchPayloadHash(current)) return current;
    current = next;
  }
  return current;
};

const sanitizeUploadChunkOnce = (chunk: IngestBatch): IngestBatch => {
  const sanitized = toConvexSafeSessionIntelligenceBatch(chunk);
  return {
    ...sanitized,
    sessions: sanitized.sessions.map((session, index) => {
      const control = chunk.sessions[index] as
        | (NormalizedSession & SessionUploadControlMetadata)
        | undefined;
      return {
        ...session,
        ...(control?.expectedEventIds !== undefined
          ? { expectedEventIds: projectExpectedIds(control.expectedEventIds, "event") }
          : {}),
        ...(control?.expectedToolCallIds !== undefined
          ? { expectedToolCallIds: projectExpectedIds(control.expectedToolCallIds, "tool_call") }
          : {}),
        ...(control?.expectedContentBlockIds !== undefined
          ? { expectedContentBlockIds: projectExpectedIds(control.expectedContentBlockIds, "content_block") }
          : {}),
        ...(control?.expectedSessionEdgeIds !== undefined
          ? { expectedSessionEdgeIds: projectExpectedIds(control.expectedSessionEdgeIds, "session_edge") }
          : {}),
        ...(control?.expectedUsageRecordIds !== undefined
          ? { expectedUsageRecordIds: projectExpectedIds(control.expectedUsageRecordIds, "usage_record") }
          : {}),
        ...(control?.expectedArtifactIds !== undefined
          ? { expectedArtifactIds: projectExpectedIds(control.expectedArtifactIds, "artifact") }
          : {}),
        ...(control?.partialSession !== undefined ? { partialSession: control.partialSession } : {}),
        ...(control?.deferCleanup !== undefined ? { deferCleanup: control.deferCleanup } : {}),
      } as NormalizedSession;
    }),
  };
};

const projectExpectedIds = (
  ids: readonly string[],
  kind:
    | "event"
    | "tool_call"
    | "content_block"
    | "session_edge"
    | "usage_record"
    | "artifact",
) => ids.map((id) => projectSessionIntelligenceGraphId(kind, id));

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
): NormalizedSession[] =>
  chunkSessionRanges(session, options).map((range) =>
    sessionChunk(session, range.start, range.end),
  );

type SessionChunkRange = {
  readonly start: number;
  readonly end: number;
};

const chunkSessionRanges = (
  session: NormalizedSession,
  options: Required<ChunkOptions>,
): SessionChunkRange[] => {
  if (
    session.events.length <= options.maxEventsPerChunk &&
    estimatedChunkOperations(session, session.events, 0) <=
      options.maxOperationsPerChunk
  ) {
    return [{ start: 0, end: session.events.length }];
  }
  const ranges: SessionChunkRange[] = [];
  let start = 0;
  let operations = 0;

  for (let index = 0; index < session.events.length; index += 1) {
    const event = session.events[index]!;
    const eventOperations = estimatedEventOperations(session, event);
    const eventLimitReached = index - start >= options.maxEventsPerChunk;
    const operationLimitReached =
      index > start && operations + eventOperations > options.maxOperationsPerChunk;

    if (eventLimitReached || operationLimitReached) {
      ranges.push({ start, end: index });
      start = index;
      operations = 0;
    }

    operations += eventOperations;
  }

  if (start < session.events.length) {
    ranges.push({ start, end: session.events.length });
  }
  return ranges.length === 0 ? [{ start: 0, end: session.events.length }] : ranges;
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
        edgeBelongsToChunk(edge, eventIds, isLast),
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
      edgeBelongsToChunk(edge, eventIds, false),
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
  edge: NormalizedSession["sessionEdges"][number],
  eventIds: Set<string>,
  includeUnresolvedEdges: boolean,
) => {
  if (edge.toEventId !== undefined) return eventIds.has(edge.toEventId);
  if (edge.fromEventId !== undefined) return eventIds.has(edge.fromEventId);
  return includeUnresolvedEdges &&
    edge.fromEventId === undefined &&
    edge.toEventId === undefined;
};

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

type SessionUploadControlMetadata = SessionCleanupMetadata & {
  readonly partialSession?: boolean;
  readonly deferCleanup?: boolean;
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
        const uploadStatus = importJobUploadSummary(status);
        if (isFinalJobStatus(status.jobStatus)) {
          return { timedOut: false, uploadStatus, ...status };
        }
        if (isIdleUploadIncompleteImportJob(status)) {
          return { timedOut: false, uploadIncomplete: true, uploadStatus, ...status };
        }
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
