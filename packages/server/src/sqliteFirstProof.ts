import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { embeddingProfileFromEnv, type EmbeddingProfile } from "./embeddingProfiles";
import type { Embedder } from "./embeddings";
import { fts5QueryForText, positiveInt } from "./fts5";

const SEARCHABLE_ROLES = ["user", "assistant", "reasoning"] as const;
const DEFAULT_QUERIES = [
  "sqlite fts search readiness",
  "embedding profile vector dimension",
  "tool payloads session search",
] as const;

export interface ProofQueryTiming {
  readonly query: string;
  readonly ftsQuery: string;
  readonly elapsedMs: number;
  readonly hits: number;
}

export interface ProofQueryBenchmark {
  readonly query: string;
  readonly ftsQuery: string;
  readonly filters: {
    readonly projectKey?: string;
    readonly role?: string;
  };
  readonly samples: number;
  readonly limit: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly hits: number;
}

export interface EmbeddingCoverageReport {
  readonly semanticRows: number;
  readonly distinctDocumentHashes: number;
  readonly activeProfileCacheHashes: number;
  readonly cachedDocumentHashes: number;
  readonly missingDocumentHashes: number;
  readonly likelyQueryCacheHashes: number;
  readonly missingExamples: readonly {
    readonly sessionId: string;
    readonly seq: number;
    readonly documentHash: string;
  }[];
}

export interface FtsProofReport {
  readonly rowsIndexed: number;
  readonly buildElapsedMs: number;
  readonly queryTimings: readonly ProofQueryTiming[];
  readonly filteredBenchmarks: readonly ProofQueryBenchmark[];
}

export interface VectorMaterializationReport {
  readonly rowLimit: number;
  readonly rowsScanned: number;
  readonly rowsInserted: number;
  readonly rowsMissingCache: number;
  readonly dimension?: number;
  readonly materializeElapsedMs: number;
}

export type ExactScanKernelName = "usearch" | "pure-js";

export interface ExactScanReport {
  readonly implementation: "pure-js-float32-baseline" | "usearch-exact-cosine";
  readonly kernel: {
    readonly package?: "usearch";
    readonly version?: "2.25.3";
    readonly metric: "cosine-similarity";
    readonly threads?: number;
  };
  readonly queryAnchor?: {
    readonly sessionId: string;
    readonly seq: number;
  };
  readonly samples: number;
  readonly rowsScanned: number;
  readonly elapsedMs: number;
  readonly minMs: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
  readonly best?: {
    readonly sessionId: string;
    readonly seq: number;
    readonly score: number;
  };
}

export interface EmbeddingParityReport {
  readonly cachedProfile: EmbeddingProfile;
  readonly localProfile: EmbeddingProfile;
  readonly requestedSampleSize: number;
  readonly eligibleCachedMessages: number;
  readonly sampleSize: number;
  readonly batchSize: number;
  readonly threshold: number;
  readonly passed: boolean;
  readonly elapsedMs: number;
  readonly scores: {
    readonly min: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
  };
  readonly belowThreshold: readonly {
    readonly sessionId: string;
    readonly seq: number;
    readonly score: number;
  }[];
}

export interface SqliteFirstProofReport {
  readonly generatedAt: string;
  readonly sourceDb: string;
  readonly workDb: string;
  readonly profile: EmbeddingProfile;
  readonly embeddingCoverage: EmbeddingCoverageReport;
  readonly fts: FtsProofReport;
  readonly vectors: VectorMaterializationReport;
  readonly exactScan: ExactScanReport;
  readonly embeddingParity?: EmbeddingParityReport;
}

export interface SqliteFirstProofOptions {
  readonly sourceDb: string;
  readonly workDb: string;
  readonly profile?: EmbeddingProfile;
  readonly queries?: readonly string[];
  readonly ftsLimit?: number;
  readonly ftsBenchmarkSamples?: number;
  readonly ftsFilterProjectKey?: string;
  readonly ftsFilterRole?: string;
  readonly vectorLimit?: number;
  readonly exactScanLimit?: number;
  readonly exactScanSamples?: number;
  readonly exactScanKernel?: ExactScanKernelName;
  readonly exactScanThreads?: number;
}

export type SqliteFirstProofErrorCode =
  | "work_db_exists"
  | "mixed_vector_dimensions"
  | "invalid_parity_threshold"
  | "parity_embedder_short_response";

export class SqliteFirstProofError extends Error {
  constructor(
    readonly code: SqliteFirstProofErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SqliteFirstProofError";
  }
}

export const documentEmbeddingInput = (text: string, profile: Pick<EmbeddingProfile, "documentPrefix">): string =>
  `${profile.documentPrefix ?? ""}${text}`;

export const sha256 = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export const documentCacheKey = (text: string, profile: Pick<EmbeddingProfile, "documentPrefix">): string =>
  sha256(documentEmbeddingInput(text, profile));

const quoteSqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

export const ftsProjectScopeToken = (projectKey: string): string =>
  `p${createHash("sha1").update(projectKey).digest("hex")}`;

export const ftsRoleScopeToken = (role: string): string =>
  `r${role.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

const elapsed = <A>(run: () => A): { readonly value: A; readonly elapsedMs: number } => {
  const startedAt = performance.now();
  const value = run();
  return { value, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 };
};

function quantile(sortedValues: readonly number[], q: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(q * sortedValues.length) - 1));
  return sortedValues[index] ?? 0;
}

const timingStats = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    minMs: sorted[0] ?? 0,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95),
    p99Ms: quantile(sorted, 0.99),
    maxMs: sorted[sorted.length - 1] ?? 0,
  };
};

type UsearchExactSearchResult = {
  readonly keys: BigUint64Array;
  readonly distances: Float32Array;
};

type UsearchKernel = {
  readonly exactSearch: (
    dataset: Float32Array,
    queries: Float32Array,
    dimensions: number,
    count: number,
    metric: unknown,
    threads?: number,
  ) => UsearchExactSearchResult;
  readonly metricCos: unknown;
};

const requireModule = createRequire(import.meta.url);

const exactScanImplementation = (kernel: ExactScanKernelName): ExactScanReport["implementation"] =>
  kernel === "usearch" ? "usearch-exact-cosine" : "pure-js-float32-baseline";

const exactScanKernelReport = (
  kernel: ExactScanKernelName,
  threads: number,
): ExactScanReport["kernel"] =>
  kernel === "usearch"
    ? { package: "usearch", version: "2.25.3", metric: "cosine-similarity", threads }
    : { metric: "cosine-similarity" };

const loadUsearchKernel = (): UsearchKernel => {
  const loaded = requireModule("usearch") as {
    readonly exactSearch: UsearchKernel["exactSearch"];
    readonly MetricKind: { readonly Cos: unknown };
  };
  return { exactSearch: loaded.exactSearch, metricCos: loaded.MetricKind.Cos };
};

export const snapshotSqliteDatabase = (sourceDb: string, workDb: string): void => {
  if (existsSync(workDb)) {
    throw new SqliteFirstProofError("work_db_exists", `workDb already exists: ${workDb}`);
  }
  mkdirSync(dirname(workDb), { recursive: true });
  const source = new Database(sourceDb, { readonly: true });
  try {
    source.exec(`VACUUM INTO ${quoteSqlString(workDb)}`);
  } finally {
    source.close();
  }
};

export const inspectEmbeddingCoverage = (
  db: Database,
  profile: EmbeddingProfile,
  options: { readonly missingExampleLimit?: number } = {},
): EmbeddingCoverageReport => {
  const cacheHashes = new Set<string>();
  for (const row of db
    .query("SELECT content_hash AS contentHash FROM embedding_cache WHERE model = $model")
    .iterate({ $model: profile.cacheNamespace }) as Iterable<{ contentHash: string }>) {
    cacheHashes.add(row.contentHash);
  }

  const documentHashes = new Set<string>();
  const missingSeen = new Set<string>();
  const missingExamples: Array<{
    readonly sessionId: string;
    readonly seq: number;
    readonly documentHash: string;
  }> = [];
  const missingExampleLimit = options.missingExampleLimit ?? 20;
  let semanticRows = 0;

  for (const row of db
    .query(
      `SELECT session_id AS sessionId, seq, text
       FROM messages
       WHERE role IN ($user, $assistant, $reasoning)
       ORDER BY session_id, seq`,
    )
    .iterate({
      $user: SEARCHABLE_ROLES[0],
      $assistant: SEARCHABLE_ROLES[1],
      $reasoning: SEARCHABLE_ROLES[2],
    }) as Iterable<{ sessionId: string; seq: number; text: string }>) {
    semanticRows += 1;
    const documentHash = documentCacheKey(row.text, profile);
    documentHashes.add(documentHash);
    if (!cacheHashes.has(documentHash) && !missingSeen.has(documentHash)) {
      missingSeen.add(documentHash);
      if (missingExamples.length < missingExampleLimit) {
        missingExamples.push({ sessionId: row.sessionId, seq: row.seq, documentHash });
      }
    }
  }

  const cachedDocumentHashes = documentHashes.size - missingSeen.size;
  return {
    semanticRows,
    distinctDocumentHashes: documentHashes.size,
    activeProfileCacheHashes: cacheHashes.size,
    cachedDocumentHashes,
    missingDocumentHashes: missingSeen.size,
    likelyQueryCacheHashes: Math.max(0, cacheHashes.size - cachedDocumentHashes),
    missingExamples,
  };
};

export const buildFtsProof = (
  db: Database,
  options: {
    readonly queries?: readonly string[];
    readonly limit?: number;
    readonly benchmarkSamples?: number;
    readonly filterProjectKey?: string;
    readonly filterRole?: string;
  } = {},
): FtsProofReport => {
  const queries = options.queries ?? DEFAULT_QUERIES;
  const limit = positiveInt(options.limit, 10);
  const benchmarkSamples = positiveInt(options.benchmarkSamples, 1);
  const build = elapsed(() => {
    db.exec("DROP TABLE IF EXISTS proof_messages_fts");
    db.exec(`
      CREATE VIRTUAL TABLE proof_messages_fts USING fts5(
        session_id UNINDEXED,
        seq UNINDEXED,
        role UNINDEXED,
        project_key UNINDEXED,
        text,
        content_hash UNINDEXED,
        tokenize = 'unicode61'
      )
    `);
    const rows = db.query(`
      SELECT session_id AS sessionId, seq, role, project_key AS projectKey, text, content_hash AS contentHash
      FROM messages
      WHERE role IN ('user', 'assistant', 'reasoning')
      ORDER BY session_id, seq
    `);
    const insert = db.prepare(`
      INSERT INTO proof_messages_fts(session_id, seq, role, project_key, text, content_hash)
      VALUES ($sessionId, $seq, $role, $projectKey, $text, $contentHash)
    `);
    const projectTokens = new Map<string, string>();
    const insertRows = db.transaction(() => {
      for (const row of rows.iterate() as Iterable<{
        sessionId: string;
        seq: number;
        role: string;
        projectKey: string;
        text: string;
        contentHash: string;
      }>) {
        let projectToken = projectTokens.get(row.projectKey);
        if (projectToken === undefined) {
          projectToken = ftsProjectScopeToken(row.projectKey);
          projectTokens.set(row.projectKey, projectToken);
        }
        insert.run({
          $sessionId: row.sessionId,
          $seq: row.seq,
          $role: row.role,
          $projectKey: row.projectKey,
          $text: `${projectToken} ${ftsRoleScopeToken(row.role)} ${row.text}`,
          $contentHash: row.contentHash,
        });
      }
    });
    insertRows();
  });
  const rowsIndexed = (db.query("SELECT COUNT(*) AS count FROM proof_messages_fts").get() as { count: number }).count;

  const queryTimings: ProofQueryTiming[] = [];
  const statement = db.query(`
    SELECT session_id AS sessionId, seq, bm25(proof_messages_fts) AS score
    FROM proof_messages_fts
    WHERE proof_messages_fts MATCH $query
    ORDER BY score
    LIMIT $limit
  `);
  for (const query of queries) {
    const ftsQuery = fts5QueryForText(query);
    if (ftsQuery === undefined) continue;
    const timing = elapsed(() => statement.all({ $query: ftsQuery, $limit: limit }));
    queryTimings.push({
      query,
      ftsQuery,
      elapsedMs: timing.elapsedMs,
      hits: timing.value.length,
    });
  }

  const defaultFilter = db.query(`
    SELECT project_key AS projectKey
    FROM proof_messages_fts
    GROUP BY project_key
    ORDER BY COUNT(*) DESC, project_key
    LIMIT 1
  `).get() as { projectKey: string } | null;
  const filters = {
    projectKey: options.filterProjectKey ?? defaultFilter?.projectKey,
    role: options.filterRole ?? "assistant",
  };
  const benchmarkStatement = db.query(`
    SELECT session_id AS sessionId, seq, bm25(proof_messages_fts) AS score
    FROM proof_messages_fts
    WHERE proof_messages_fts MATCH $query
      AND ($projectKey IS NULL OR project_key = $projectKey)
      AND ($role IS NULL OR role = $role)
    ORDER BY score
    LIMIT $limit
  `);
  const filteredBenchmarks: ProofQueryBenchmark[] = [];
  for (const query of queries) {
    const ftsQuery = fts5QueryForText(query);
    if (ftsQuery === undefined) continue;
    const scopedTerms = [
      filters.projectKey === undefined ? undefined : ftsProjectScopeToken(filters.projectKey),
      filters.role === undefined ? undefined : ftsRoleScopeToken(filters.role),
      ftsQuery,
    ].filter((term): term is string => term !== undefined);
    const scopedFtsQuery = scopedTerms.join(" AND ");
    const timings: number[] = [];
    let hits = 0;
    for (let sample = 0; sample < benchmarkSamples; sample += 1) {
      const timing = elapsed(() =>
        benchmarkStatement.all({
          $query: scopedFtsQuery,
          $projectKey: filters.projectKey ?? null,
          $role: filters.role ?? null,
          $limit: limit,
        }),
      );
      timings.push(timing.elapsedMs);
      if (sample === 0) hits = timing.value.length;
    }
    filteredBenchmarks.push({
      query,
      ftsQuery: scopedFtsQuery,
      filters,
      samples: benchmarkSamples,
      limit,
      ...timingStats(timings),
      hits,
    });
  }

  return { rowsIndexed, buildElapsedMs: build.elapsedMs, queryTimings, filteredBenchmarks };
};

const vectorToBlob = (vector: readonly number[]): Buffer => {
  const typed = new Float32Array(vector);
  return Buffer.from(typed.buffer);
};

const vectorFromBlob = (blob: Uint8Array): Float32Array => {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
};

const vectorMagnitude = (vector: readonly number[]): number => {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
};

const cosineNumbers = (a: readonly number[], b: readonly number[]): number => {
  const aMagnitude = vectorMagnitude(a);
  const bMagnitude = vectorMagnitude(b);
  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0);
  return dot / (aMagnitude * bMagnitude);
};

type CachedParityCandidate = {
  readonly sessionId: string;
  readonly seq: number;
  readonly text: string;
  readonly cachedVector: readonly number[];
};

type CachedParitySampleRow = {
  readonly sessionId: string;
  readonly seq: number;
  readonly text: string;
  readonly documentHash: string;
};

const deterministicRandom = () => {
  let state = 0x9e3779b9;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const selectCachedParityCandidates = (
  db: Database,
  profile: EmbeddingProfile,
  requestedSampleSize: number,
): { readonly eligibleCachedMessages: number; readonly sample: readonly CachedParityCandidate[] } => {
  const cacheHashes = new Set<string>();
  for (const row of db
    .query("SELECT content_hash AS contentHash FROM embedding_cache WHERE model = $model")
    .iterate({ $model: profile.cacheNamespace }) as Iterable<{ contentHash: string }>) {
    cacheHashes.add(row.contentHash);
  }
  const selectCache = db.query(`
    SELECT vector_json AS vectorJson
    FROM embedding_cache
    WHERE model = $model AND content_hash = $contentHash
  `);
  const messages = db.query(`
    SELECT session_id AS sessionId, seq, text
    FROM messages
    WHERE role IN ('user', 'assistant', 'reasoning')
    ORDER BY session_id, seq
  `);

  const random = deterministicRandom();
  const sampledRows: CachedParitySampleRow[] = [];
  let eligibleCachedMessages = 0;
  for (const row of messages.iterate() as Iterable<{ sessionId: string; seq: number; text: string }>) {
    const documentHash = documentCacheKey(row.text, profile);
    if (!cacheHashes.has(documentHash)) continue;
    eligibleCachedMessages += 1;
    const sampleRow = { ...row, documentHash };
    if (sampledRows.length < requestedSampleSize) {
      sampledRows.push(sampleRow);
      continue;
    }
    const replacementIndex = Math.floor(random() * eligibleCachedMessages);
    if (replacementIndex < requestedSampleSize) {
      sampledRows[replacementIndex] = sampleRow;
    }
  }
  if (sampledRows.length === 0) return { eligibleCachedMessages, sample: [] };

  const sample: CachedParityCandidate[] = [];
  for (const row of sampledRows.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq)) {
    const cached = selectCache.get({
      $model: profile.cacheNamespace,
      $contentHash: row.documentHash,
    }) as { vectorJson: string } | null;
    if (cached !== null) {
      sample.push({
        sessionId: row.sessionId,
        seq: row.seq,
        text: row.text,
        cachedVector: JSON.parse(cached.vectorJson) as readonly number[],
      });
    }
  }
  return { eligibleCachedMessages, sample };
};

export const measureEmbeddingParity = async (
  db: Database,
  cachedProfile: EmbeddingProfile,
  localProfile: EmbeddingProfile,
  embedder: Embedder,
  options: { readonly sampleSize: number; readonly threshold: number; readonly batchSize?: number },
): Promise<EmbeddingParityReport> => {
  const requestedSampleSize = positiveInt(options.sampleSize, 1_000);
  const batchSize = positiveInt(options.batchSize, 32);
  const threshold = options.threshold;
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
    throw new SqliteFirstProofError("invalid_parity_threshold", `invalid parity threshold: ${threshold}`);
  }

  const startedAt = performance.now();
  const { eligibleCachedMessages, sample } = selectCachedParityCandidates(db, cachedProfile, requestedSampleSize);
  const scores: number[] = [];
  const belowThreshold: Array<{ readonly sessionId: string; readonly seq: number; readonly score: number }> = [];

  for (let offset = 0; offset < sample.length; offset += batchSize) {
    const batch = sample.slice(offset, offset + batchSize);
    const inputs = batch.map((row) => documentEmbeddingInput(row.text, localProfile));
    const localVectors = await embedder.embedMany(inputs);
    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index]!;
      const localVector = localVectors[index];
      if (localVector === undefined) {
        throw new SqliteFirstProofError("parity_embedder_short_response", `local embedder returned too few vectors for parity batch at offset ${offset}`);
      }
      const score = cosineNumbers(row.cachedVector, localVector);
      scores.push(score);
      if (score < threshold && belowThreshold.length < 20) {
        belowThreshold.push({ sessionId: row.sessionId, seq: row.seq, score });
      }
    }
  }

  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  return {
    cachedProfile,
    localProfile,
    requestedSampleSize,
    eligibleCachedMessages,
    sampleSize: sample.length,
    batchSize,
    threshold,
    passed: sample.length === requestedSampleSize && belowThreshold.length === 0,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    scores: {
      min: sorted[0] ?? 0,
      mean,
      p50: quantile(sorted, 0.5),
      p95: quantile(sorted, 0.95),
    },
    belowThreshold,
  };
};

export const materializeProofVectors = (
  db: Database,
  profile: EmbeddingProfile,
  options: { readonly limit?: number } = {},
): VectorMaterializationReport => {
  const rowLimit = positiveInt(options.limit, 20_000);
  const startedAt = performance.now();
  db.exec("DROP TABLE IF EXISTS proof_message_vectors");
  db.exec(`
    CREATE TABLE proof_message_vectors (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      document_hash TEXT NOT NULL,
      vector_blob BLOB NOT NULL,
      magnitude REAL NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `);

  const messages = db.query(`
    SELECT session_id AS sessionId, seq, text, content_hash AS contentHash
    FROM messages
    WHERE role IN ('user', 'assistant', 'reasoning')
    ORDER BY session_id, seq
    LIMIT $limit
  `);
  const selectCache = db.query(`
    SELECT vector_json AS vectorJson
    FROM embedding_cache
    WHERE model = $model AND content_hash = $contentHash
  `);
  const insertVector = db.prepare(`
    INSERT INTO proof_message_vectors(session_id, seq, content_hash, document_hash, vector_blob, magnitude)
    VALUES ($sessionId, $seq, $contentHash, $documentHash, $vectorBlob, $magnitude)
  `);

  let rowsScanned = 0;
  let rowsInserted = 0;
  let rowsMissingCache = 0;
  let dimension: number | undefined;

  const insertBatch = db.transaction(() => {
    for (const row of messages.iterate({ $limit: rowLimit }) as Iterable<{
      sessionId: string;
      seq: number;
      text: string;
      contentHash: string;
    }>) {
      rowsScanned += 1;
      const documentHash = documentCacheKey(row.text, profile);
      const cached = selectCache.get({
        $model: profile.cacheNamespace,
        $contentHash: documentHash,
      }) as { vectorJson: string } | null;
      if (cached === null) {
        rowsMissingCache += 1;
        continue;
      }
      const vector = JSON.parse(cached.vectorJson) as number[];
      if (dimension === undefined) dimension = vector.length;
      if (vector.length !== dimension) {
        throw new SqliteFirstProofError(
          "mixed_vector_dimensions",
          `mixed vector dimensions in cache: expected ${dimension}, got ${vector.length}`,
        );
      }
      insertVector.run({
        $sessionId: row.sessionId,
        $seq: row.seq,
        $contentHash: row.contentHash,
        $documentHash: documentHash,
        $vectorBlob: vectorToBlob(vector),
        $magnitude: vectorMagnitude(vector),
      });
      rowsInserted += 1;
    }
  });
  insertBatch();

  return {
    rowLimit,
    rowsScanned,
    rowsInserted,
    rowsMissingCache,
    dimension,
    materializeElapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
  };
};

const cosineMatrixRow = (
  query: Float32Array,
  queryMagnitude: number,
  matrix: Float32Array,
  rowIndex: number,
  dimensions: number,
  rowMagnitude: number,
): number => {
  if (queryMagnitude === 0 || rowMagnitude === 0) return 0;
  let dot = 0;
  const offset = rowIndex * dimensions;
  for (let index = 0; index < dimensions; index += 1) {
    dot += (query[index] ?? 0) * (matrix[offset + index] ?? 0);
  }
  return dot / (queryMagnitude * rowMagnitude);
};

export const runExactScanBaseline = (
  db: Database,
  options: {
    readonly limit?: number;
    readonly samples?: number;
    readonly kernel?: ExactScanKernelName;
    readonly threads?: number;
  } = {},
): ExactScanReport => {
  const limit = positiveInt(options.limit, 20_000);
  const samples = positiveInt(options.samples, 1);
  const kernel = options.kernel ?? "usearch";
  const threads = positiveInt(options.threads, 1);
  const totalRow = db.query("SELECT COUNT(*) AS count FROM proof_message_vectors")
    .get() as { readonly count: number } | null;
  const rowCount = Math.min(totalRow?.count ?? 0, limit);
  if (rowCount === 0) {
    return {
      implementation: exactScanImplementation(kernel),
      kernel: exactScanKernelReport(kernel, threads),
      samples: 0,
      rowsScanned: 0,
      elapsedMs: 0,
      minMs: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    };
  }
  const rows = db.query(`
    SELECT session_id AS sessionId, seq, vector_blob AS vectorBlob, magnitude
    FROM proof_message_vectors
    ORDER BY session_id, seq
    LIMIT $limit
  `).iterate({ $limit: limit }) as Iterable<{
    sessionId: string;
    seq: number;
    vectorBlob: Uint8Array;
    magnitude: number;
  }>;

  let anchor: {
    readonly sessionId: string;
    readonly seq: number;
    readonly vector: Float32Array;
    readonly magnitude: number;
  } | undefined;
  let dimensions = 0;
  let candidateMatrix: Float32Array | undefined;
  const candidateSessionIds: string[] = [];
  const candidateSeqs: number[] = [];
  const candidateMagnitudes: number[] = [];

  let index = 0;
  for (const row of rows) {
    const vector = vectorFromBlob(row.vectorBlob);
    if (index === 0) {
      anchor = { sessionId: row.sessionId, seq: row.seq, vector, magnitude: row.magnitude };
      dimensions = vector.length;
      if (rowCount > 1) {
        candidateMatrix = new Float32Array((rowCount - 1) * dimensions);
      }
    } else {
      if (vector.length !== dimensions) {
        throw new SqliteFirstProofError(
          "mixed_vector_dimensions",
          `mixed vector dimensions in proof vectors: expected ${dimensions}, got ${vector.length}`,
        );
      }
      const candidateIndex = index - 1;
      candidateMatrix!.set(vector, candidateIndex * dimensions);
      candidateSessionIds.push(row.sessionId);
      candidateSeqs.push(row.seq);
      candidateMagnitudes.push(row.magnitude);
    }
    index += 1;
  }
  if (anchor === undefined) {
    return {
      implementation: exactScanImplementation(kernel),
      kernel: exactScanKernelReport(kernel, threads),
      samples: 0,
      rowsScanned: 0,
      elapsedMs: 0,
      minMs: 0,
      medianMs: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    };
  }
  const queryVector = anchor.vector;
  const queryMagnitude = anchor.magnitude;
  const candidateCount = candidateSessionIds.length;
  const usearchKernel = kernel === "usearch" && candidateCount > 0 ? loadUsearchKernel() : undefined;
  const scanPureJsOnce = (): ExactScanReport["best"] => {
    let best: ExactScanReport["best"];
    if (candidateMatrix === undefined) return undefined;
    for (let rowIndex = 0; rowIndex < candidateCount; rowIndex += 1) {
      const score = cosineMatrixRow(
        queryVector,
        queryMagnitude,
        candidateMatrix,
        rowIndex,
        dimensions,
        candidateMagnitudes[rowIndex] ?? 0,
      );
      if (best === undefined || score > best.score) {
        best = { sessionId: candidateSessionIds[rowIndex]!, seq: candidateSeqs[rowIndex]!, score };
      }
    }
    return best;
  };
  const scanUsearchOnce = (): ExactScanReport["best"] => {
    if (usearchKernel === undefined || candidateMatrix === undefined || candidateCount === 0) return undefined;
    const result = usearchKernel.exactSearch(candidateMatrix, queryVector, dimensions, 1, usearchKernel.metricCos, threads);
    const candidateIndex = Number(result.keys[0]);
    const sessionId = candidateSessionIds[candidateIndex];
    const seq = candidateSeqs[candidateIndex];
    if (sessionId === undefined || seq === undefined) return undefined;
    const distance = result.distances[0] ?? Number.POSITIVE_INFINITY;
    return { sessionId, seq, score: 1 - distance };
  };
  const scanOnce = kernel === "usearch" ? scanUsearchOnce : scanPureJsOnce;
  const timings: number[] = [];
  let best: ExactScanReport["best"];
  for (let sample = 0; sample < samples; sample += 1) {
    const scan = elapsed(scanOnce);
    timings.push(scan.elapsedMs);
    if (sample === 0) best = scan.value;
  }
  const stats = timingStats(timings);
  return {
    implementation: exactScanImplementation(kernel),
    kernel: exactScanKernelReport(kernel, threads),
    queryAnchor: { sessionId: anchor.sessionId, seq: anchor.seq },
    samples,
    rowsScanned: candidateCount,
    elapsedMs: timings[0] ?? 0,
    ...stats,
    best,
  };
};

export const runSqliteFirstProof = (options: SqliteFirstProofOptions): SqliteFirstProofReport => {
  const profile = options.profile ?? embeddingProfileFromEnv();
  snapshotSqliteDatabase(options.sourceDb, options.workDb);
  const db = new Database(options.workDb);
  try {
    const embeddingCoverage = inspectEmbeddingCoverage(db, profile);
    const fts = buildFtsProof(db, {
      queries: options.queries,
      limit: options.ftsLimit,
      benchmarkSamples: options.ftsBenchmarkSamples,
      filterProjectKey: options.ftsFilterProjectKey,
      filterRole: options.ftsFilterRole,
    });
    const vectors = materializeProofVectors(db, profile, { limit: options.vectorLimit });
    const exactScan = runExactScanBaseline(db, {
      limit: options.exactScanLimit ?? options.vectorLimit,
      samples: options.exactScanSamples,
      kernel: options.exactScanKernel,
      threads: options.exactScanThreads,
    });
    return {
      generatedAt: new Date().toISOString(),
      sourceDb: options.sourceDb,
      workDb: options.workDb,
      profile,
      embeddingCoverage,
      fts,
      vectors,
      exactScan,
    };
  } finally {
    db.close();
  }
};
