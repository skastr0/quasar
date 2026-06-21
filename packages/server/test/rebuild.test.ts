/**
 * Derived search is rebuildable from SQLite truth (QSR-216).
 *
 * AGENTS.md principle 3: SQLite is the truth store; LanceDB is DERIVED lexical/
 * vector/fusion state. This test proves the derived index can be destroyed and
 * fully reconstructed from the stored sessions alone:
 *
 *   1. upsert a session into SQLite + index it into LanceDB, confirm search hits
 *   2. WIPE the entire LanceDB data directory (the derived state on disk)
 *   3. open a fresh LanceDB and rebuild it by walking SQLite sessions through
 *      the existing reindex path (listSessions -> indexSession), with NO new
 *      ingest and NO access to the original provider history
 *   4. confirm the same lexical search still returns the row
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-rebuild-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mappedSession = (): MappedSession => ({
  project: { projectKey: "rebuild-project", displayName: "Rebuild Project", rawPath: "/tmp/rebuild-project" },
  session: {
    sessionId: "rebuild-session",
    projectKey: "rebuild-project",
    provider: "codex",
    agentName: "codex",
    sourcePath: "/history/rebuild-session.jsonl",
    sourceFingerprint: "rebuild-fingerprint",
    host: "rebuild-host",
    identitySchemeVersion: 1,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [
    {
      sessionId: "rebuild-session",
      seq: 1,
      role: "user",
      text: "reconstructable from sqlite truth",
      projectKey: "rebuild-project",
      contentHash: "rebuild-hash-1",
    },
  ],
  toolCalls: [],
});

const lexicalTexts = (matches: readonly { readonly row: { readonly text: string } }[]) =>
  matches.map((hit) => hit.row.text);

describe("derived search rebuild from SQLite truth", () => {
  test("a wiped LanceDB index is rebuilt from stored sessions and search still returns the row", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    const lance = join(dir, "search.lance");

    const dataLayer = (lanceDir: string) =>
      Layer.mergeAll(makeLocalStoreLayer(sqlite), makeLanceDbLayer({ dataDir: lanceDir }));
    const searchLayer = (lanceDir: string) => DerivedSearchLive.pipe(Layer.provide(dataLayer(lanceDir)));
    const layer = (lanceDir: string) => Layer.merge(dataLayer(lanceDir), searchLayer(lanceDir));

    // 1. Ingest into SQLite truth + build the derived index, confirm it serves.
    const before = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const search = yield* DerivedSearch;
          yield* store.upsertSession(mappedSession());
          yield* search.indexSession("rebuild-session");
          yield* search.createLexicalIndex;
          return yield* search.lexicalSearch({ query: "reconstructable" });
        }).pipe(Effect.provide(layer(lance))),
      ),
    );
    expect(lexicalTexts(before)).toEqual(["reconstructable from sqlite truth"]);

    // 2. WIPE the derived state entirely. SQLite is untouched.
    rmSync(lance, { recursive: true, force: true });

    // 3 + 4. Open a fresh LanceDB and rebuild ONLY from SQLite by walking the
    // stored sessions through the reindex path; then prove search recovers.
    const after = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* LocalStore;
          const search = yield* DerivedSearch;
          const lanceDb = yield* LanceDb;
          // Fresh derived store: no message rows exist yet.
          const empty = yield* lanceDb
            .readMessageRowsBySession({ sessionId: "rebuild-session", limit: 100, select: ["contentHash"] })
            .pipe(Effect.catchAll(() => Effect.succeed([] as readonly unknown[])));
          // Rebuild from SQLite truth: list sessions, reindex each.
          const sessions = yield* store.listSessions({ limit: 1000 });
          yield* Effect.forEach(sessions, (session) => search.indexSession(session.sessionId), { discard: true });
          yield* search.createLexicalIndex;
          const matches = yield* search.lexicalSearch({ query: "reconstructable" });
          return { emptyCount: empty.length, matches } as const;
        }).pipe(Effect.provide(layer(lance))),
      ),
    );

    expect(after.emptyCount).toBe(0);
    expect(lexicalTexts(after.matches)).toEqual(["reconstructable from sqlite truth"]);
  }, 20_000);
});
