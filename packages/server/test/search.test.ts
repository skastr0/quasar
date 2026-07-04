import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer, MESSAGE_SEARCH_COLUMNS } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { MappedSession } from "../src/model";
import { embeddingProfileFromEnv, embeddingProfileSearchTable } from "../src/embeddingProfiles";
import { DerivedSearch, DerivedSearchLive, messageSearchFilter, providerFromSessionId } from "../src/search";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import { VECTOR_READY_FILTER } from "../src/searchPolicy";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-local-search-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (messages: MappedSession["messages"]): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId: "session-a",
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    title: "Search fixture",
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: "/history/session-a.jsonl",
    sourceFingerprint: `fingerprint-${messages.length}`,
    host: "host-a",
    identitySchemeVersion: 1,
    messageCount: messages.length,
    toolCallCount: 0,
  },
  messages,
  toolCalls: [],
});

const message = (seq: number, text: string): MappedSession["messages"][number] => ({
  sessionId: "session-a",
  seq,
  role: seq === 1 ? "user" : "assistant",
  text,
  ts: `2026-06-18T10:0${seq}:00.000Z`,
  projectKey: "project-a",
  contentHash: `hash-${seq}-${text.replaceAll(" ", "-")}`,
});

const longText = () => "oversized message memory\n".repeat(3_000);

const embeddingEnvKeys = [
  "QUASAR_EMBEDDING_MODEL",
  "QUASAR_EMBEDDING_DIMENSIONS",
  "QUASAR_EMBEDDING_TASK",
  "QUASAR_EMBEDDING_CACHE_NAMESPACE",
  "QUASAR_EMBEDDING_DOCUMENT_PREFIX",
  "QUASAR_EMBEDDING_QUERY_PREFIX",
] as const;

const withSearch = <A>(
  run: Effect.Effect<A, unknown, LocalStore | LanceDb | DerivedSearch>,
  embeddingEnv: Partial<Record<(typeof embeddingEnvKeys)[number], string>> = {},
) => {
  const previousEnv = Object.fromEntries(
    embeddingEnvKeys.map((key) => [key, process.env[key]] as const),
  );
  for (const key of embeddingEnvKeys) {
    const value = embeddingEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(
    makeLocalStoreLayer(sqlite),
    makeLanceDbLayer({ dataDir: lance }),
  );
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  return Effect.runPromise(
    run.pipe(Effect.provide(Layer.merge(dataLayer, searchLayer))),
  ).finally(() => {
    for (const key of embeddingEnvKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

const mappedSessionFor = (
  sessionId: string,
  provider: string,
  messages: MappedSession["messages"],
): MappedSession => ({
  project: { projectKey: "project-a", displayName: "Project A", rawPath: "/tmp/project-a" },
  session: {
    sessionId,
    projectKey: "project-a",
    provider,
    agentName: provider,
    title: `Search fixture (${provider})`,
    startedAt: "2026-06-18T10:00:00.000Z",
    updatedAt: "2026-06-18T10:01:00.000Z",
    sourcePath: `/history/${sessionId}.jsonl`,
    sourceFingerprint: `fingerprint-${messages.length}-${provider}`,
    host: "host-a",
    identitySchemeVersion: 1,
    messageCount: messages.length,
    toolCallCount: 0,
  },
  messages,
  toolCalls: [],
});

const messageFor = (sessionId: string, seq: number, text: string): MappedSession["messages"][number] => ({
  sessionId,
  seq,
  role: seq === 1 ? "user" : "assistant",
  text,
  ts: `2026-06-18T10:0${seq}:00.000Z`,
  projectKey: "project-a",
  contentHash: `hash-${sessionId}-${seq}-${text.replaceAll(" ", "-")}`,
});

describe("DerivedSearch", () => {
  test("providerFromSessionId extracts prefix before first colon", () => {
    expect(providerFromSessionId("codex:abc123")).toBe("codex");
    expect(providerFromSessionId("opencode:some:nested:id")).toBe("opencode");
    expect(providerFromSessionId("session-a")).toBe("session-a");
    expect(providerFromSessionId("")).toBe("");
  });

  test("messageSearchFilter with single provider emits equality predicate", () => {
    expect(messageSearchFilter({ providers: ["codex"] })).toBe("provider = 'codex'");
  });

  test("messageSearchFilter with multiple providers emits IN predicate", () => {
    expect(messageSearchFilter({ providers: ["codex", "opencode"] })).toBe(
      "provider IN ('codex', 'opencode')",
    );
  });

  test("messageSearchFilter with providers + role + base combines all clauses", () => {
    expect(
      messageSearchFilter({ role: "user", providers: ["codex"] }, VECTOR_READY_FILTER),
    ).toBe("contentHash NOT LIKE 'unembedded:%' AND role = 'user' AND provider = 'codex'");
  });

  test("message search filters combine vector readiness with project and role filters", () => {
    expect(messageSearchFilter({ projectKey: "project-a", role: "assistant" }, VECTOR_READY_FILTER)).toBe(
      "contentHash NOT LIKE 'unembedded:%' AND projectKey = 'project-a' AND role = 'assistant'",
    );
    expect(messageSearchFilter({ projectKey: "project-'quoted", role: "user" })).toBe(
      "projectKey = 'project-''quoted' AND role = 'user'",
    );
  });

  test("upserts SQLite-derived message rows and reports stats", async () => {
    const [report, stats] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        const report = yield* derived.indexSession("session-a");
        const stats = yield* derived.stats;
        return [report, stats] as const;
      }),
    );

    expect(report).toEqual({
      sessionId: "session-a",
      rowsUpserted: 2,
      semanticRowsUpserted: 2,
      orphansDeleted: 0,
    });
    expect(stats.rowCount).toBe(2);
  });

  test("deletes search rows no longer present in SQLite truth", async () => {
    const [first, second, stats] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        const first = yield* derived.indexSession("session-a");
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal") ]));
        const second = yield* derived.indexSession("session-a");
        const stats = yield* derived.stats;
        return [first, second, stats] as const;
      }),
    );

    expect(first.rowsUpserted).toBe(2);
    expect(second).toEqual({
      sessionId: "session-a",
      rowsUpserted: 1,
      semanticRowsUpserted: 1,
      orphansDeleted: 2,
    });
    expect(stats.rowCount).toBe(1);
  });

  test("keeps oversized messages semantic-eligible", async () => {
    const [report, hits, rows] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const evidence = message(2, longText());
        yield* store.upsertSession(mappedSession([message(1, "small decision memory"), evidence]));
        const report = yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        const hits = yield* derived.lexicalSearch({ query: "oversized", limit: 10 });
        const search = yield* LanceDb;
        const rows = yield* search.readMessageRowsBySession({ sessionId: "session-a", select: ["contentHash"] });
        return [report, hits, rows] as const;
      }),
    );

    expect(report).toMatchObject({ rowsUpserted: 2, semanticRowsUpserted: 2 });
    expect(hits.map((hit) => hit.row.text)).toEqual([longText()]);
    expect(rows.map((row) => row.contentHash)).toContain("unembedded:hash-1-small-decision-memory");
    expect(rows.some((row) => String(row.contentHash).startsWith("unembedded:hash-2-oversized-message-memory"))).toBe(true);
  });

  test("lexical search works after explicit index creation", async () => {
    const hits = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal"), message(2, "beta shell") ]));
        yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        return yield* derived.lexicalSearch({ query: "terminal", limit: 10 });
      }),
    );

    expect(hits.map((hit) => hit.row.text)).toEqual(["alpha terminal"]);
  });

  test("lexical search can filter by message role", async () => {
    const [userHits, assistantHits] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(mappedSession([message(1, "shared memory token"), message(2, "shared memory token") ]));
        yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        const userHits = yield* derived.lexicalSearch({ query: "shared", role: "user", limit: 10 });
        const assistantHits = yield* derived.lexicalSearch({ query: "shared", role: "assistant", limit: 10 });
        return [userHits, assistantHits] as const;
      }),
    );

    expect(userHits.map((hit) => hit.row.role)).toEqual(["user"]);
    expect(assistantHits.map((hit) => hit.row.role)).toEqual(["assistant"]);
  });

  test("SQLite FTS lexical search matches LanceDB lexical on a fixed filtered query set", async () => {
    const comparisons = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const search = yield* LanceDb;
        const codexSessionId = "codex:fixed-parity";
        const opencodeSessionId = "opencode:fixed-parity";
        yield* store.upsertSession(
          mappedSessionFor(codexSessionId, "codex", [
            messageFor(codexSessionId, 1, "codex memory fragment"),
            { ...messageFor(codexSessionId, 2, "assistant recall fragment"), role: "assistant" },
          ]),
        );
        yield* store.upsertSession(
          mappedSessionFor(opencodeSessionId, "opencode", [
            messageFor(opencodeSessionId, 1, "opencode memory fragment"),
          ]),
        );
        yield* derived.indexSession(codexSessionId);
        yield* derived.indexSession(opencodeSessionId);
        yield* derived.createLexicalIndex;

        const requests = [
          { query: "memory", limit: 10 },
          { query: "fragment", providers: ["codex"], limit: 10 },
          { query: "assistant", role: "assistant", limit: 10 },
        ] as const;

        const rows: Array<{ readonly sqlite: string[]; readonly lance: string[]; readonly scores: readonly number[] }> = [];
        for (const request of requests) {
          const sqlite = yield* store.lexicalSearch(request);
          const lance = yield* search.ftsSearch({
            query: request.query,
            filter: messageSearchFilter({
              role: request.role,
              providers: request.providers,
            }),
            limit: request.limit,
            select: MESSAGE_SEARCH_COLUMNS,
          });
          const keyFor = (hit: { readonly row: Record<string, unknown> }) =>
            `${String(hit.row.sessionId)}:${String(hit.row.seq)}:${String(hit.row.role)}`;
          rows.push({
            sqlite: sqlite.map(keyFor),
            lance: lance.map(keyFor),
            scores: sqlite.map((hit) => hit.score),
          });
        }
        return rows;
      }),
    );

    expect(comparisons.every((comparison) => comparison.sqlite.length > 0)).toBe(true);
    expect(comparisons.map((comparison) => comparison.sqlite)).toEqual(
      comparisons.map((comparison) => comparison.lance),
    );
    const scores = comparisons.flatMap((comparison) => comparison.scores);
    expect(scores.every((score) => Number.isFinite(score) && score > 0 && score <= 1)).toBe(true);
    for (const comparison of comparisons) {
      expect([...comparison.scores].sort((a, b) => b - a)).toEqual(comparison.scores);
    }
  });

  test("keeps lexical rows global while alternate profiles use their own vector table", async () => {
    const [profileTable, lexicalRows, profileRows, hits, stats] = await withSearch(
      Effect.gen(function* () {
        const profile = embeddingProfileFromEnv();
        const profileTable = embeddingProfileSearchTable(profile);
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession([message(1, "nomic lexical memory") ]));
        yield* derived.indexSession("session-a");
        yield* derived.createLexicalIndex;
        const lexicalRows = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          tableName: "messages",
          select: ["key", "vector"],
        });
        const profileRows = yield* search.readMessageRowsBySession({
          sessionId: "session-a",
          tableName: profileTable,
          select: ["key", "vector"],
        });
        const hits = yield* derived.lexicalSearch({ query: "nomic", limit: 10 });
        const stats = yield* derived.stats;
        return [profileTable, lexicalRows, profileRows, hits, stats] as const;
      }),
      {
        QUASAR_EMBEDDING_MODEL: "hf:nomic-ai/nomic-embed-text-v1.5",
        QUASAR_EMBEDDING_DIMENSIONS: "768",
      },
    );

    expect(profileTable).not.toBe("messages");
    expect(lexicalRows).toHaveLength(1);
    expect(profileRows).toHaveLength(1);
    expect((lexicalRows[0]?.vector as readonly number[] | undefined)?.length).toBe(1536);
    expect((profileRows[0]?.vector as readonly number[] | undefined)?.length).toBe(768);
    expect(hits.map((hit) => hit.row.text)).toEqual(["nomic lexical memory"]);
    expect(stats.tableName).toBe(profileTable);
    expect(stats.rowCount).toBe(1);
  });

  test("createLexicalIndex builds text_idx after indexSession; subsequent calls are idempotent", async () => {
    const [afterIndex, afterCreate, afterIdempotent] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const search = yield* LanceDb;
        yield* store.upsertSession(mappedSession([message(1, "alpha terminal") ]));
        yield* derived.indexSession("session-a");
        // indexSession writes rows but does not optimize inline — text_idx is not present yet.
        const afterIndex = yield* search.tableStats({ tableName: "messages" });
        // createLexicalIndex (called by the maintenance worker) folds rows into the FTS index.
        yield* derived.createLexicalIndex;
        const afterCreate = yield* search.tableStats({ tableName: "messages" });
        // Calling createLexicalIndex again is idempotent.
        yield* derived.createLexicalIndex;
        const afterIdempotent = yield* search.tableStats({ tableName: "messages" });
        return [afterIndex, afterCreate, afterIdempotent] as const;
      }),
    );

    // After indexSession alone, text_idx is NOT present.
    expect(afterIndex.indices.map((index) => index.name)).not.toContain("text_idx");
    // After createLexicalIndex, text_idx is present.
    expect(afterCreate.indices.map((index) => index.name)).toContain("text_idx");
    // Calling createLexicalIndex again is idempotent.
    expect(afterIdempotent.indices.map((index) => index.name)).toContain("text_idx");
  });

  test("provider column is derived from sessionId prefix and searchable via provider filter", async () => {
    const codexSessionId = "codex:session-001";
    const opencodeSessionId = "opencode:session-001";

    const [codexHits, opencodeHits, allHits, codexRows] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const search = yield* LanceDb;

        // Ingest one codex session and one opencode session, both with "memory" in text.
        yield* store.upsertSession(
          mappedSessionFor(codexSessionId, "codex", [
            messageFor(codexSessionId, 1, "codex memory fragment"),
          ]),
        );
        yield* store.upsertSession(
          mappedSessionFor(opencodeSessionId, "opencode", [
            messageFor(opencodeSessionId, 1, "opencode memory fragment"),
          ]),
        );
        yield* derived.indexSession(codexSessionId);
        yield* derived.indexSession(opencodeSessionId);
        yield* derived.createLexicalIndex;

        const codexHits = yield* derived.lexicalSearch({
          query: "memory",
          providers: ["codex"],
          limit: 10,
        });
        const opencodeHits = yield* derived.lexicalSearch({
          query: "memory",
          providers: ["opencode"],
          limit: 10,
        });
        const allHits = yield* derived.lexicalSearch({ query: "memory", limit: 10 });

        // Read raw rows to verify the provider column is populated correctly.
        const codexRows = yield* search.readMessageRowsBySession({
          sessionId: codexSessionId,
          select: ["provider"],
        });

        return [codexHits, opencodeHits, allHits, codexRows] as const;
      }),
    );

    // Provider filter restricts results to the matching harness.
    expect(codexHits.map((h) => h.row.sessionId)).toEqual([codexSessionId]);
    expect(opencodeHits.map((h) => h.row.sessionId)).toEqual([opencodeSessionId]);
    // Without a provider filter both sessions are returned.
    expect(allHits).toHaveLength(2);
    // The raw LanceDB row carries the correct provider value.
    expect(codexRows.map((r) => r.provider)).toEqual(["codex"]);
  });
});
