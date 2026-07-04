import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";

import { embeddingProfileFromEnv, type EmbeddingProfile } from "./embeddingProfiles";

const SEARCHABLE_ROLES = ["user", "assistant", "reasoning"] as const;
const DEFAULT_QUERIES = [
  "sqlite lancedb search readiness",
  "embedding profile vector dimension",
  "tool payloads session search",
] as const;

export interface ProofQueryTiming {
  readonly query: string;
  readonly ftsQuery: string;
  readonly elapsedMs: number;
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
}

export interface VectorMaterializationReport {
  readonly rowLimit: number;
  readonly rowsScanned: number;
  readonly rowsInserted: number;
  readonly rowsMissingCache: number;
  readonly dimension?: number;
  readonly materializeElapsedMs: number;
}

export interface ExactScanReport {
  readonly implementation: "pure-js-float32-baseline";
  readonly queryAnchor?: {
    readonly sessionId: string;
    readonly seq: number;
  };
  readonly rowsScanned: number;
  readonly elapsedMs: number;
  readonly best?: {
    readonly sessionId: string;
    readonly seq: number;
    readonly score: number;
  };
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
}

export interface SqliteFirstProofOptions {
  readonly sourceDb: string;
  readonly workDb: string;
  readonly profile?: EmbeddingProfile;
  readonly queries?: readonly string[];
  readonly ftsLimit?: number;
  readonly vectorLimit?: number;
  readonly exactScanLimit?: number;
}

export type SqliteFirstProofErrorCode =
  | "work_db_exists"
  | "mixed_vector_dimensions";

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

export const fts5QueryForText = (query: string): string | undefined => {
  const tokens = query.match(/[\p{L}\p{N}]+/gu)?.map((token) => token.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
};

const quoteSqlString = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

const elapsed = <A>(run: () => A): { readonly value: A; readonly elapsedMs: number } => {
  const startedAt = performance.now();
  const value = run();
  return { value, elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100 };
};

const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;

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
  options: { readonly queries?: readonly string[]; readonly limit?: number } = {},
): FtsProofReport => {
  const queries = options.queries ?? DEFAULT_QUERIES;
  const limit = positiveInt(options.limit, 10);
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
    db.exec(`
      INSERT INTO proof_messages_fts(session_id, seq, role, project_key, text, content_hash)
      SELECT session_id, seq, role, project_key, text, content_hash
      FROM messages
      WHERE role IN ('user', 'assistant', 'reasoning')
    `);
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

  return { rowsIndexed, buildElapsedMs: build.elapsedMs, queryTimings };
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

const cosine = (a: Float32Array, aMagnitude: number, b: Float32Array, bMagnitude: number): number => {
  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) dot += (a[index] ?? 0) * (b[index] ?? 0);
  return dot / (aMagnitude * bMagnitude);
};

export const runExactScanBaseline = (
  db: Database,
  options: { readonly limit?: number } = {},
): ExactScanReport => {
  const limit = positiveInt(options.limit, 20_000);
  const rows = db.query(`
    SELECT session_id AS sessionId, seq, vector_blob AS vectorBlob, magnitude
    FROM proof_message_vectors
    ORDER BY session_id, seq
    LIMIT $limit
  `).all({ $limit: limit }) as Array<{
    sessionId: string;
    seq: number;
    vectorBlob: Uint8Array;
    magnitude: number;
  }>;
  if (rows.length === 0 || rows[0] === undefined) {
    return { implementation: "pure-js-float32-baseline", rowsScanned: 0, elapsedMs: 0 };
  }
  const [anchor, ...candidates] = rows;
  const queryVector = vectorFromBlob(anchor.vectorBlob);
  const queryMagnitude = anchor.magnitude;
  let best: ExactScanReport["best"];
  const scan = elapsed(() => {
    for (const row of candidates) {
      const score = cosine(queryVector, queryMagnitude, vectorFromBlob(row.vectorBlob), row.magnitude);
      if (best === undefined || score > best.score) {
        best = { sessionId: row.sessionId, seq: row.seq, score };
      }
    }
  });
  return {
    implementation: "pure-js-float32-baseline",
    queryAnchor: { sessionId: anchor.sessionId, seq: anchor.seq },
    rowsScanned: candidates.length,
    elapsedMs: scan.elapsedMs,
    best,
  };
};

export const runSqliteFirstProof = (options: SqliteFirstProofOptions): SqliteFirstProofReport => {
  const profile = options.profile ?? embeddingProfileFromEnv();
  snapshotSqliteDatabase(options.sourceDb, options.workDb);
  const db = new Database(options.workDb);
  try {
    const embeddingCoverage = inspectEmbeddingCoverage(db, profile);
    const fts = buildFtsProof(db, { queries: options.queries, limit: options.ftsLimit });
    const vectors = materializeProofVectors(db, profile, { limit: options.vectorLimit });
    const exactScan = runExactScanBaseline(db, { limit: options.exactScanLimit ?? options.vectorLimit });
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
