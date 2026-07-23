import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { profileCacheNamespace } from "../src/embeddingProfiles";
import type { MappedSession } from "../src/model";
import { LocalStore, makeLocalStoreLayer, type MessageVectorUpsert } from "../src/store";

// The spawned server runs QUASAR_EMBEDDING_PROVIDER=synthetic with the default
// profile, so seeded vectors must live under the same cache namespace.
const MODEL = profileCacheNamespace({
  model: "hf:nomic-ai/nomic-embed-text-v1.5",
  dimensions: 768,
  task: "search_document",
});
const DIMS = 768;

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-semantic-serving-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Deterministic embedding geometry shared by the seeded corpus and the
 * embedding stub: a text carrying `angle=X` maps to [cos X, sin X, 0, ...],
 * so cosine similarity to a query with angle Q is exactly cos(X - Q). */
const angleVector = (theta: number): number[] => {
  const vector = Array(DIMS).fill(0);
  vector[0] = Math.cos(theta);
  vector[1] = Math.sin(theta);
  return vector;
};

const angleFromText = (text: string): number => {
  const match = /angle=([0-9.]+)/.exec(text);
  return match === null ? 1.5 : Number(match[1]);
};

const fixtureSession = (
  sessionId: string,
  projectKey: string,
  texts: readonly string[],
): MappedSession => ({
  project: { projectKey, displayName: projectKey, rawPath: `/tmp/${projectKey}` },
  session: {
    sessionId,
    projectKey,
    provider: "codex",
    agentName: "codex",
    title: sessionId,
    startedAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:05:00.000Z",
    sourcePath: `/history/${sessionId}.jsonl`,
    sourceFingerprint: `fp-${sessionId}`,
    host: "host-test",
    identitySchemeVersion: 1,
    normalizationVersion: 2,
    messageCount: texts.length,
    toolCallCount: 0,
  },
  messages: texts.map((text, seq) => ({
    sessionId,
    seq,
    role: seq % 2 === 0 ? ("assistant" as const) : ("user" as const),
    text,
    ts: "2026-07-01T10:00:00.000Z",
    projectKey,
    contentHash: `hash-${sessionId}-${seq}`,
  })),
  toolCalls: [],
});

const vectorsFor = (session: MappedSession): MessageVectorUpsert[] =>
  session.messages.map((message) => ({
    model: MODEL,
    modality: "text",
    sessionId: message.sessionId,
    seq: message.seq,
    role: message.role,
    projectKey: message.projectKey,
    provider: "codex",
    contentHash: message.contentHash,
    documentHash: `doc-${message.contentHash}`,
    vector: angleVector(angleFromText(message.text)),
    now: "2026-07-01T10:10:00.000Z",
  }));

const seed = (sqlite: string) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const alpha = fixtureSession("codex:alpha", "project-alpha", [
          "handshake protocol notes angle=0.1",
          "alpha follow-up angle=0.4",
        ]);
        const beta = fixtureSession("codex:beta", "project-beta", [
          "beta deployment retro angle=0.25",
          "beta incident log angle=0.7",
        ]);
        yield* store.upsertSession(alpha);
        yield* store.upsertSession(beta);
        yield* store.upsertMessageVectors([...vectorsFor(alpha), ...vectorsFor(beta)]);
      }).pipe(Effect.provide(makeLocalStoreLayer(sqlite))),
    ),
  );

/** OpenAI-compatible /embeddings stub with the angle geometry. */
const startEmbeddingStub = () => {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/embeddings") {
        const body = (await request.json()) as { input: string[] };
        return Response.json({
          data: body.input.map((text, index) => ({ index, embedding: angleVector(angleFromText(text)) })),
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return server;
};

const waitForSemanticReady = async (base: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const body = (await (await fetch(`${base}/ready`)).json()) as {
        data?: { modes?: { semantic?: boolean } };
      };
      if (body.data?.modes?.semantic === true) return;
    } catch {
      // server not up yet
    }
    await Bun.sleep(50);
  }
  throw new Error("server never reported semantic readiness");
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as any };
};

describe("semantic serving from the resident matrix", () => {
  test("serves /ready, /search/semantic, and /search/fusion once booted with vectors", async () => {
    const dir = tempDir();
    const sqlite = join(dir, "quasar.sqlite");
    await seed(sqlite);

    const stub = startEmbeddingStub();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const base = `http://127.0.0.1:${port}`;
    const proc = Bun.spawn(["bun", "run", "src/main.ts", "--host", "127.0.0.1", "--port", String(port)], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        QUASAR_LOCAL_SQLITE: sqlite,
        QUASAR_EMBEDDING_PROVIDER: "synthetic",
        // Hermetic: this test pins the SYNTHETIC query path (including the
        // stub-loss 503); the local fp32 pipeline must never activate here.
        QUASAR_QUERY_EMBEDDING_PROVIDER: "synthetic",
        SYNTHETIC_API_KEY: "stub-key",
        SYNTHETIC_OPENAI_BASE_URL: `http://127.0.0.1:${stub.port}`,
      },
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      await waitForSemanticReady(base);

      const ready = await fetchJson(`${base}/ready`);
      expect(ready.status).toBe(200);
      expect(ready.body).toMatchObject({
        ok: true,
        command: "ready",
        data: {
          modes: { lexical: true, semantic: true, fusion: true },
          matrix: { model: MODEL, rows: 4, dimensions: DIMS, kernel: "simsimd-ffi" },
        },
      });
      expect(ready.body.data.reason).toBeUndefined();

      // Query at angle 0.1: alpha:0 (0.1) then beta:0 (0.25) then alpha:1 (0.4).
      const semantic = await fetchJson(`${base}/search/semantic?q=${encodeURIComponent("find the handshake angle=0.1")}&limit=3`);
      expect(semantic.status).toBe(200);
      expect(semantic.body.ok).toBe(true);
      const semanticKeys = semantic.body.data.matches.map((match: { key: string }) => match.key);
      expect(semanticKeys).toEqual([
        "codex:alpha:0:assistant",
        "codex:beta:0:assistant",
        "codex:alpha:1:user",
      ]);
      const scores = semantic.body.data.matches.map((match: { score: number }) => match.score);
      expect(scores[0]).toBeGreaterThan(scores[1]);
      expect(scores[1]).toBeGreaterThan(scores[2]);
      expect(semantic.body.data.matches[0].row).toMatchObject({
        sessionId: "codex:alpha",
        seq: 0,
        role: "assistant",
        projectKey: "project-alpha",
        provider: "codex",
        text: "handshake protocol notes angle=0.1",
        contentHash: "hash-codex:alpha-0",
      });

      // Exact SQL-prefiltered scan: only project-beta rows are eligible.
      const filtered = await fetchJson(
        `${base}/search/semantic?q=${encodeURIComponent("query angle=0.1")}&limit=10&projectKey=project-beta`,
      );
      expect(filtered.status).toBe(200);
      expect(filtered.body.data.matches.map((match: { key: string }) => match.key)).toEqual([
        "codex:beta:0:assistant",
        "codex:beta:1:user",
      ]);

      const roleFiltered = await fetchJson(
        `${base}/search/semantic?q=${encodeURIComponent("query angle=0.1")}&limit=10&role=user`,
      );
      expect(roleFiltered.status).toBe(200);
      expect(
        roleFiltered.body.data.matches.every((match: { row: { role: string } }) => match.row.role === "user"),
      ).toBe(true);

      // Fusion: "handshake" only matches alpha:0 lexically AND it ranks first
      // semantically, so RRF must put it on top; a semantic-only neighbor follows.
      const fusion = await fetchJson(`${base}/search/fusion?q=${encodeURIComponent("handshake angle=0.1")}&limit=3`);
      expect(fusion.status).toBe(200);
      const fusionKeys = fusion.body.data.matches.map((match: { key: string }) => match.key);
      expect(fusionKeys[0]).toBe("codex:alpha:0:assistant");
      expect(fusionKeys.length).toBe(3);
      expect(fusion.body.data.matches[0].score).toBeGreaterThan(fusion.body.data.matches[1].score);

      // Embedder loss while the matrix is resident: semantic mode is
      // EmbeddingUnavailable (503), never SemanticDisabled, and lexical is untouched.
      stub.stop(true);
      const unavailable = await fetchJson(`${base}/search/semantic?q=${encodeURIComponent("fresh uncached query")}&limit=3`);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.type).toBe("EmbeddingUnavailable");
      const lexical = await fetchJson(`${base}/search/lexical?q=handshake&limit=3`);
      expect(lexical.status).toBe(200);
      expect(lexical.body.data.matches.length).toBe(1);

      // Fusion never 503s for the same embedder loss: it degrades to the
      // lexical leg alone (a fresh, uncached query text forces a real embed
      // call against the dead stub instead of a cache hit).
      const fusionDegraded = await fetchJson(`${base}/search/fusion?q=handshake&limit=3`);
      expect(fusionDegraded.status).toBe(200);
      expect(fusionDegraded.body.ok).toBe(true);
      expect(fusionDegraded.body.data.degraded).toBe(true);
      expect(fusionDegraded.body.data.matches.length).toBe(1);
      expect(fusionDegraded.body.data.matches[0].row.text).toBe("handshake protocol notes angle=0.1");
    } finally {
      proc.kill();
      await proc.exited;
      stub.stop(true);
    }
  }, 30_000);
});
