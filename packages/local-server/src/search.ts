import {
  GEMINI_EMBEDDING_DIMENSIONS,
  LanceDb,
  MESSAGE_SEARCH_COLUMNS,
  type MessageSearchRow,
  type SearchHit,
  type TableStatsReport,
} from "@skastr0/quasar-search";
import { Context, Effect, Layer } from "effect";

import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "./embeddingProfiles";
import type { MessageRow } from "./model";
import { decideSearchDocument, indexedContentHash, VECTOR_READY_FILTER } from "./searchPolicy";
import { LocalStore } from "./store";

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
    readonly limit?: number;
  }) => Effect.Effect<readonly SearchHit[], unknown>;
}

export class DerivedSearch extends Context.Tag("@quasar/DerivedSearch")<
  DerivedSearch,
  DerivedSearchService
>() {}

const projectFilter = (projectKey: string | undefined): string | undefined =>
  projectKey === undefined ? undefined : `projectKey = '${projectKey.replaceAll("'", "''")}'`;

const keyFor = (message: Pick<MessageRow, "sessionId" | "seq" | "role">) =>
  `${message.sessionId}:${message.seq}:${message.role}`;

const toSearchRows = (messages: readonly MessageRow[], vectorDimensions: number): MessageSearchRow[] =>
  messages.flatMap((message) => {
    const decision = decideSearchDocument(message);
    if (!decision.lexical || (message.role !== "user" && message.role !== "assistant")) return [];
    return [
      {
        sessionId: message.sessionId,
        seq: message.seq,
        role: message.role,
        projectKey: message.projectKey,
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
          const lexicalRows = toSearchRows(messages, GEMINI_EMBEDDING_DIMENSIONS);
          const profileRows = profileTable === LEXICAL_TABLE ? lexicalRows : toSearchRows(messages, profile.dimensions);
          const nextKeys = new Set(profileRows.map((row) => keyFor(row)));
          const profileOrphansDeleted = yield* deleteOrphans(profileTable, sessionId, nextKeys);
          const lexicalOrphansDeleted = profileTable === LEXICAL_TABLE ? 0 : yield* deleteOrphans(LEXICAL_TABLE, sessionId, nextKeys);
          if (lexicalRows.length > 0) {
            yield* search.upsertMessageRows({ rows: lexicalRows, tableName: LEXICAL_TABLE, vectorDimension: GEMINI_EMBEDDING_DIMENSIONS });
          }
          if (profileTable !== LEXICAL_TABLE && profileRows.length > 0) {
            yield* search.upsertMessageRows({ rows: profileRows, tableName: profileTable, vectorDimension: profile.dimensions });
          }
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
      lexicalSearch: ({ query, projectKey, limit }) =>
        search.ftsSearch({
          tableName: LEXICAL_TABLE,
          query,
          limit,
          filter: projectFilter(projectKey),
          select: MESSAGE_SEARCH_COLUMNS,
        }),
    });
  }),
);
