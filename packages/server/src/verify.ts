/**
 * Index verification — the one place SQLite truth meets Lance truth, and the ONLY
 * place an IndexProof can be minted. There is no setter for "indexed": you may not
 * assert it, only measure it, and the measurement is one of three states. The
 * catastrophic "advertised indexed while rows are missing/stale" state has no
 * inhabitant — it collapses to Divergent, a named, recoverable value carrying the
 * exact offending keys.
 *
 * Design (council-hardened):
 *  - witness is (key, contentDigest) PAIRS, not bare keys → a re-keyed session that
 *    serves old text reads Divergent(stale), never Converged.
 *  - the proof is version-guarded: the session's (updated_at, message_count) is read
 *    before and after the Lance read-back; if it moved, re-verify rather than mint
 *    over a snapshot that no longer exists.
 *  - mintProof is module-private and the proof brand is a module-private symbol, so
 *    no other module can construct or forge a proof.
 */
import { Data, Effect, Schema } from "effect";

import { DEFAULT_SEARCH_TABLE, LanceDb, type LanceDbError } from "./lancedb";
import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import type { DivergenceRow } from "./model";
import { normalizeIndexedContentHash } from "./searchPolicy";
import { LocalStore, type SqliteStoreError } from "./store";

const nowIso = () => new Date().toISOString();

// A re-ingest racing verification is rare; a small bounded retry closes the TOCTOU
// window without risking an unbounded loop on a session under constant rewrite.
const MAX_VERIFY_ATTEMPTS = 3;

const IndexProofBrand: unique symbol = Symbol("quasar/IndexProof");
/** Proof that a session's index was witnessed complete by a read-back. Un-forgeable:
 * the brand is a module-private symbol and {@link mintProof} is not exported. */
export interface IndexProof {
  readonly [IndexProofBrand]: true;
  readonly sessionId: string;
  readonly witnessed: ReadonlyMap<string, string>;
  readonly tables: readonly string[];
  readonly at: string;
}

const mintProof = (fields: {
  readonly sessionId: string;
  readonly witnessed: ReadonlyMap<string, string>;
  readonly tables: readonly string[];
  readonly at: string;
}): IndexProof => ({ ...fields, [IndexProofBrand]: true }) as IndexProof;

export class SessionDelta extends Schema.Class<SessionDelta>("SessionDelta")({
  sessionId: Schema.String,
  table: Schema.String,
  expected: Schema.Int,
  present: Schema.Int,
  missingKeys: Schema.Array(Schema.String),
  staleKeys: Schema.Array(Schema.String),
  extraKeys: Schema.Array(Schema.String),
}) {
  get converged(): boolean {
    return this.missingKeys.length + this.staleKeys.length + this.extraKeys.length === 0;
  }
  /** Stale (present-but-wrong) or extra (present-but-unexpected) keys are structural
   * corruption — never ratio-gated, never served degraded. */
  get structural(): boolean {
    return this.staleKeys.length > 0 || this.extraKeys.length > 0;
  }
}

export type SessionIndexState = Data.TaggedEnum<{
  NeverIndexed: { readonly sessionId: string };
  Converged: { readonly sessionId: string; readonly proof: IndexProof };
  Divergent: { readonly sessionId: string; readonly deltas: ReadonlyArray<SessionDelta> };
}>;
export const {
  NeverIndexed,
  Converged,
  Divergent,
  $match: matchState,
  $is: isState,
} = Data.taggedEnum<SessionIndexState>();

/** Raised by indexSession when a session is still Divergent after writing, so the
 * existing index-session retry/maxAttempts machinery heals it without an inline loop. */
export class IndexDivergent extends Schema.TaggedError<IndexDivergent>()("IndexDivergent", {
  sessionId: Schema.String,
  missing: Schema.Int,
  stale: Schema.Int,
  extra: Schema.Int,
}) {}

/** The Lance tables a session must cover to be Converged: the lexical table always,
 * plus the active vector profile table when it is distinct. */
export const ownedSearchTables = (): readonly string[] => {
  const profileTable = embeddingProfileSearchTable(embeddingProfileFromEnv());
  return profileTable === DEFAULT_SEARCH_TABLE
    ? [DEFAULT_SEARCH_TABLE]
    : [DEFAULT_SEARCH_TABLE, profileTable];
};

/** Pure set/content diff of intended vs persisted (key -> normalized contentHash). */
export const diffPairs = (
  sessionId: string,
  table: string,
  intended: ReadonlyMap<string, string>,
  persisted: ReadonlyMap<string, string>,
): SessionDelta => {
  const missingKeys: string[] = [];
  const staleKeys: string[] = [];
  for (const [key, digest] of intended) {
    const got = persisted.get(key);
    if (got === undefined) missingKeys.push(key);
    else if (got !== digest) staleKeys.push(key);
  }
  const extraKeys: string[] = [];
  for (const key of persisted.keys()) {
    if (!intended.has(key)) extraKeys.push(key);
  }
  return new SessionDelta({
    sessionId,
    table,
    expected: intended.size,
    present: persisted.size,
    missingKeys,
    staleKeys,
    extraKeys,
  });
};

/** Collapse per-table deltas into one divergence-ledger row for a session. */
export const mergeDivergence = (
  sessionId: string,
  deltas: ReadonlyArray<SessionDelta>,
): DivergenceRow => {
  const missing = new Set<string>();
  const stale = new Set<string>();
  const extra = new Set<string>();
  let expected = 0;
  let present = 0;
  for (const delta of deltas) {
    expected = Math.max(expected, delta.expected);
    present = Math.max(present, delta.present);
    for (const key of delta.missingKeys) missing.add(key);
    for (const key of delta.staleKeys) stale.add(key);
    for (const key of delta.extraKeys) extra.add(key);
  }
  return {
    sessionId,
    expected,
    present,
    missingKeys: [...missing],
    staleKeys: [...stale],
    extraKeys: [...extra],
  };
};

const persistedPairs = (
  sessionId: string,
  tableName: string,
): Effect.Effect<ReadonlyMap<string, string>, LanceDbError, LanceDb> =>
  Effect.gen(function* () {
    const search = yield* LanceDb;
    const rows = yield* search.readMessageRowsBySession({
      sessionId,
      tableName,
      limit: 100_000,
      select: ["key", "contentHash"],
    });
    const pairs = new Map<string, string>();
    for (const row of rows) {
      const key = row.key;
      if (typeof key !== "string") continue;
      const digest = normalizeIndexedContentHash(row.contentHash);
      if (digest === undefined) continue;
      pairs.set(key, digest);
    }
    return pairs;
  });

const verifyAttempt = (
  sessionId: string,
  attempt: number,
): Effect.Effect<SessionIndexState, SqliteStoreError | LanceDbError, LocalStore | LanceDb> =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const v0 = yield* store.sessionVersion(sessionId);
    const intended = yield* store.intendedPairs(sessionId);
    if (intended.size === 0) return NeverIndexed({ sessionId });
    const tables = ownedSearchTables();
    const deltas: SessionDelta[] = [];
    for (const table of tables) {
      const persisted = yield* persistedPairs(sessionId, table);
      deltas.push(diffPairs(sessionId, table, intended, persisted));
    }
    const v1 = yield* store.sessionVersion(sessionId);
    const moved = v0.updatedAt !== v1.updatedAt || v0.messageCount !== v1.messageCount;
    if (moved && attempt < MAX_VERIFY_ATTEMPTS) {
      return yield* verifyAttempt(sessionId, attempt + 1);
    }
    return deltas.every((delta) => delta.converged)
      ? Converged({ sessionId, proof: mintProof({ sessionId, witnessed: intended, tables, at: nowIso() }) })
      : Divergent({ sessionId, deltas });
  });

/** Measure a session's index state. The sole IndexProof mint. */
export const verifyIndexed = (sessionId: string) => verifyAttempt(sessionId, 0);
