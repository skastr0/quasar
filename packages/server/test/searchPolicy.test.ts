import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LanceDb, makeLanceDbLayer } from "../src/lancedb";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import type { MappedSession } from "../src/model";
import { DerivedSearch, DerivedSearchLive } from "../src/search";
import { decideSearchDocument, isSearchableRole } from "../src/searchPolicy";
import { LocalStore, makeLocalStoreLayer } from "../src/store";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-search-policy-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const withSearch = <A>(
  run: Effect.Effect<A, unknown, LocalStore | LanceDb | DerivedSearch>,
) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const lance = join(tempDir(), "search.lance");
  const dataLayer = Layer.mergeAll(
    makeLocalStoreLayer(sqlite),
    makeLanceDbLayer({ dataDir: lance }),
  );
  const searchLayer = DerivedSearchLive.pipe(Layer.provide(dataLayer));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.merge(dataLayer, searchLayer))));
};

const reasoningSession = (text: string): MappedSession => ({
  project: { projectKey: "project-r", displayName: "Project R", rawPath: "/tmp/project-r" },
  session: {
    sessionId: "session-r",
    projectKey: "project-r",
    provider: "codex",
    agentName: "codex",
    title: "Reasoning fixture",
    startedAt: "2026-06-22T10:00:00.000Z",
    updatedAt: "2026-06-22T10:01:00.000Z",
    sourcePath: "/history/session-r.jsonl",
    sourceFingerprint: "fp-reasoning",
    host: "host-r",
    identitySchemeVersion: 1,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [
    {
      sessionId: "session-r",
      seq: 0,
      role: "reasoning",
      text,
      ts: "2026-06-22T10:00:01.000Z",
      projectKey: "project-r",
      contentHash: `hash-reasoning-${text.slice(0, 16)}`,
    },
  ],
  toolCalls: [],
});

describe("searchPolicy — reasoning role", () => {
  test("isSearchableRole accepts reasoning", () => {
    expect(isSearchableRole("reasoning")).toBe(true);
    expect(isSearchableRole("user")).toBe(true);
    expect(isSearchableRole("assistant")).toBe(true);
    expect(isSearchableRole("system")).toBe(false);
    expect(isSearchableRole("tool")).toBe(false);
  });

  test("decideSearchDocument marks reasoning as lexical AND semantic", () => {
    const decision = decideSearchDocument({ role: "reasoning", text: "the model struggled here" });
    expect(decision.kind).toBe("semantic");
    expect(decision.lexical).toBe(true);
    expect(decision.semantic).toBe(true);
    expect(decision.reason).toBe("semantic-eligible");
  });

  test("reasoning message is indexed and findable via lexical search", async () => {
    const [report, hits] = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(reasoningSession("the model struggled on this edge case deeply"));
        const report = yield* derived.indexSession("session-r");
        yield* derived.createLexicalIndex;
        const hits = yield* derived.lexicalSearch({ query: "struggled", limit: 10 });
        return [report, hits] as const;
      }),
    );

    expect(report.rowsUpserted).toBe(1);
    expect(report.semanticRowsUpserted).toBe(1);
    expect(hits.length).toBe(1);
    expect(hits[0]?.row.role).toBe("reasoning");
    expect(hits[0]?.row.text).toContain("struggled");
  });

  test("reasoning role filter passes through to lexical search without zero results", async () => {
    const hits = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        yield* store.upsertSession(reasoningSession("deep analysis of the token budget tradeoff"));
        yield* derived.indexSession("session-r");
        yield* derived.createLexicalIndex;
        return yield* derived.lexicalSearch({ query: "token", role: "reasoning", limit: 10 });
      }),
    );

    expect(hits.length).toBe(1);
    expect(hits[0]?.row.role).toBe("reasoning");
  });

  test("reasoning row gets unembedded contentHash prefix marking it semantic-eligible", async () => {
    const rows = await withSearch(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const derived = yield* DerivedSearch;
        const search = yield* LanceDb;
        yield* store.upsertSession(reasoningSession("semantic eligibility check"));
        yield* derived.indexSession("session-r");
        return yield* search.readMessageRowsBySession({
          sessionId: "session-r",
          select: ["contentHash", "role"],
        });
      }),
    );

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(String(row?.contentHash).startsWith("unembedded:")).toBe(true);
    expect(row?.role).toBe("reasoning");
  });
});
