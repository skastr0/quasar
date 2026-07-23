import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { MappedSession } from "../src/model";
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

const withStore = <A>(run: Effect.Effect<A, unknown, LocalStore>) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  return Effect.runPromise(run.pipe(Effect.provide(makeLocalStoreLayer(sqlite))));
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
    normalizationVersion: 2,
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
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
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

  test("reasoning message is findable via lexical search immediately after ingest", async () => {
    const hits = await withStore(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        yield* store.upsertSession(reasoningSession("the model struggled on this edge case deeply"));
        return yield* store.lexicalSearch({ query: "struggled", limit: 10 });
      }),
    );

    expect(hits.length).toBe(1);
    expect(hits[0]?.row.role).toBe("reasoning");
    expect(String(hits[0]?.row.text)).toContain("struggled");
  });

  test("reasoning role filter passes through to lexical search without zero results", async () => {
    const hits = await withStore(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        yield* store.upsertSession(reasoningSession("deep analysis of the token budget tradeoff"));
        return yield* store.lexicalSearch({ query: "token", role: "reasoning", limit: 10 });
      }),
    );

    expect(hits.length).toBe(1);
    expect(hits[0]?.row.role).toBe("reasoning");
  });
});
