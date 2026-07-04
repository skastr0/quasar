import {
  DEFAULT_MESSAGE_VECTOR_DIMENSIONS,
  LanceDb,
  MESSAGE_SEARCH_COLUMNS,
  type MessageSearchRow,
  type SearchHit,
  type TableStatsReport,
} from "./lancedb";
import { Context, Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import type { MessageRow } from "./model";
import { decideSearchDocument, indexedContentHash, VECTOR_READY_FILTER } from "./searchPolicy";
import { LocalStore } from "./store";
import { IndexDivergent, matchState, mergeDivergence, verifyIndexed } from "./verify";

const LEXICAL_TABLE = "messages";

export interface IndexSessionReport {
  readonly sessionId: string;
  readonly rowsUpserted: number;
  readonly semanticRowsUpserted: number;
  readonly orphansDeleted: number;
}

export interface DerivedSearchService {
  readonly indexSession: (sessionId: string) => Effect.Effect<IndexSessionReport, unknown>;
  readonly createLexicalIndex: Effect.Effect<void, unknown>;
  readonly createVectorIndex: Effect.Effect<void, unknown>;
  readonly stats: Effect.Effect<TableStatsReport, unknown>;
  readonly lexicalSearch: (request: {
    readonly query: string;
    readonly projectKey?: string;
    readonly role?: string;
    /** Optional allow-list of provider names (e.g. ["codex", "opencode"]). Empty or omitted = all providers. */
    readonly providers?: readonly string[];
    readonly limit?: number;
  }) => Effect.Effect<readonly SearchHit[], unknown>;
}

export class DerivedSearch extends Context.Tag("@quasar/DerivedSearch")<
  DerivedSearch,
  DerivedSearchService
>() {}

/** Derive provider from a sessionId of the form `<provider>:<rest>`. */
export const providerFromSessionId = (sessionId: string): string => {
  const colon = sessionId.indexOf(":");
  return colon === -1 ? sessionId : sessionId.slice(0, colon);
};

export const messageSearchFilter = (
  options: { readonly projectKey?: string; readonly role?: string; readonly providers?: readonly string[] },
  base?: string,
): string | undefined => {
  const filters: string[] = [];
  if (base !== undefined && base.trim() !== "") {
    filters.push(base);
  }
  if (options.projectKey !== undefined) {
    filters.push(`projectKey = '${options.projectKey.replaceAll("'", "''")}'`);
  }
  if (options.role !== undefined) {
    filters.push(`role = '${options.role.replaceAll("'", "''")}'`);
  }
  if (options.providers !== undefined && options.providers.length > 0) {
    if (options.providers.length === 1) {
      filters.push(`provider = '${options.providers[0]!.replaceAll("'", "''")}'`);
    } else {
      const list = options.providers.map((p) => `'${p.replaceAll("'", "''")}'`).join(", ");
      filters.push(`provider IN (${list})`);
    }
  }
  return filters.length === 0 ? undefined : filters.join(" AND ");
};

const keyFor = (message: Pick<MessageRow, "sessionId" | "seq" | "role">) =>
  `${message.sessionId}:${message.seq}:${message.role}`;

const toSearchRows = (messages: readonly MessageRow[], vectorDimensions: number): MessageSearchRow[] =>
  messages.flatMap((message) => {
    const decision = decideSearchDocument(message);
    if (!decision.lexical) return [];
    return [
      {
        sessionId: message.sessionId,
        seq: message.seq,
        role: message.role,
        projectKey: message.projectKey,
        provider: providerFromSessionId(message.sessionId),
        text: message.text,
        contentHash: indexedContentHash(message),
        vector: Array.from({ length: vectorDimensions }, () => 0),
      },
    ];
  });

export const DerivedSearchLive = Layer.effect(
  DerivedSearch,
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const search = yield* LanceDb;
    const profile = embeddingProfileFromEnv();
    const profileTable = embeddingProfileSearchTable(profile);
    const lexicalDimensions = DEFAULT_MESSAGE_VECTOR_DIMENSIONS;

    const deleteOrphans = (tableName: string, sessionId: string, nextKeys: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const existing = yield* search.readMessageRowsBySession({
          sessionId,
          tableName,
          limit: 100_000,
          select: ["key"],
        }).pipe(Effect.catchAll(() => Effect.succeed([])));
        const orphanKeys = existing
          .map((row) => row.key)
          .filter((key): key is string => typeof key === "string" && !nextKeys.has(key));
        if (orphanKeys.length > 0) {
          yield* search.deleteByKeys({ tableName, keys: orphanKeys });
        }
        return orphanKeys.length;
      });

    return DerivedSearch.of({
      indexSession: (sessionId) =>
        Effect.gen(function* () {
          const messages = yield* store.readMessages(sessionId, 100_000);
          const lexicalRows = toSearchRows(messages, lexicalDimensions);
          const profileRows = profileTable === LEXICAL_TABLE ? lexicalRows : toSearchRows(messages, profile.dimensions);
          const nextKeys = new Set(profileRows.map((row) => keyFor(row)));

          // Read the profile (vector) table's existing rows ONCE — this drives
          // BOTH orphan deletion AND the no-clobber guard. The embed worker owns
          // the vector column on the profile table; re-writing an already-embedded
          // row here would overwrite its real vector with a zero placeholder — the
          // bulk-re-index clobber that left rows permanently unembedded (index runs
          // after embed, resets the vector, and the per-row embed idempotency stops
          // a re-embed). So EXCLUDE already-embedded keys from the profile upsert
          // and leave those rows to the embed worker; index writes only new rows.
          const profileExisting = yield* search.readMessageRowsBySession({
            sessionId, tableName: profileTable, limit: 100_000, select: ["key", "contentHash"],
          }).pipe(Effect.catchAll(() => Effect.succeed([] as readonly Record<string, unknown>[])));
          const profileOrphanKeys = profileExisting
            .map((row) => row.key)
            .filter((key): key is string => typeof key === "string" && !nextKeys.has(key));
          if (profileOrphanKeys.length > 0) {
            yield* search.deleteByKeys({ tableName: profileTable, keys: profileOrphanKeys }).pipe(Effect.catchAll(() => Effect.void));
          }
          const profileOrphansDeleted = profileOrphanKeys.length;
          const embeddedKeys = new Set(
            profileExisting
              .filter((row) =>
                typeof row.key === "string" &&
                typeof row.contentHash === "string" &&
                !(row.contentHash as string).startsWith("unembedded:"))
              .map((row) => row.key as string),
          );

          // Lexical (FTS-only) table: index owns it entirely; the embed worker
          // never writes it, so a full upsert is safe (no clobber possible).
          const lexicalOrphansDeleted = profileTable === LEXICAL_TABLE ? 0 : yield* deleteOrphans(LEXICAL_TABLE, sessionId, nextKeys);
          if (profileTable !== LEXICAL_TABLE && lexicalRows.length > 0) {
            yield* search.upsertMessageRows({ rows: lexicalRows, tableName: LEXICAL_TABLE, vectorDimension: lexicalDimensions });
          }
          // Profile (vector) table: write only NEW/unembedded rows; preserve the
          // embed worker's vectors on already-embedded keys.
          const profileRowsToWrite = profileRows.filter((row) => !embeddedKeys.has(keyFor(row)));
          if (profileRowsToWrite.length > 0) {
            yield* search.upsertMessageRows({ rows: profileRowsToWrite, tableName: profileTable, vectorDimension: profile.dimensions });
          }

          // Index maintenance (create-missing + optimize) is NOT done per session:
          // optimize() compacts the whole table, so doing it on every indexSession
          // makes a bulk re-index O(sessions * table) — glacial. The coalesced
          // maintenance worker (maintenance.ts maintain()) folds newly-written rows
          // into the FTS/vector indexes once writers are idle, per table. Until then
          // the readiness gate keeps /search fail-closed (503), so the rows are never
          // served unindexed.

          // Verify the write against a read-back, then either stamp (Converged — the
          // SOLE site indexed_at is set, and only with a witnessed proof) or surface
          // Divergent so the index-session retry/maxAttempts machinery heals it. A
          // short write can no longer be stamped: the disproving keys force Divergent.
          const state = yield* verifyIndexed(sessionId).pipe(
            Effect.provideService(LocalStore, store),
            Effect.provideService(LanceDb, search),
          );
          yield* matchState(state, {
            NeverIndexed: () => Effect.void,
            Converged: (converged) =>
              store.markSessionIndexed(converged.proof).pipe(
                Effect.zipRight(store.clearDivergence(converged.sessionId)),
              ),
            Divergent: (divergent) =>
              store.putDivergence(mergeDivergence(divergent.sessionId, divergent.deltas)).pipe(
                Effect.zipRight(
                  Effect.fail(
                    new IndexDivergent({
                      sessionId: divergent.sessionId,
                      missing: divergent.deltas.reduce((total, delta) => total + delta.missingKeys.length, 0),
                      stale: divergent.deltas.reduce((total, delta) => total + delta.staleKeys.length, 0),
                      extra: divergent.deltas.reduce((total, delta) => total + delta.extraKeys.length, 0),
                    }),
                  ),
                ),
              ),
          });

          const semanticRowsUpserted = messages.filter((message) => decideSearchDocument(message).semantic).length;
          return {
            sessionId,
            rowsUpserted: profileRows.length,
            semanticRowsUpserted,
            orphansDeleted: profileOrphansDeleted + lexicalOrphansDeleted,
          };
        }),
      createLexicalIndex: search.createMessageIndexes({ tableName: LEXICAL_TABLE, includeVector: false }),
      createVectorIndex: search.createMessageIndexes({
        tableName: profileTable,
        includeVector: true,
        vectorRowsFilter: VECTOR_READY_FILTER,
      }),
      stats: search.tableStats({ tableName: profileTable }),
      lexicalSearch: ({ query, projectKey, role, providers, limit }) =>
        store.lexicalSearch({
          query,
          projectKey,
          role,
          providers,
          limit,
        }),
    });
  }),
);
