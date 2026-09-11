import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, HashMap, Layer, Logger, Tracer } from "effect";

import { makeEmbeddingProfile, type EmbeddingProfile } from "../src/embeddingProfiles";
import {
  classifyEmbeddingFailure,
  makeEmbeddingsLayer,
  type Embedder,
} from "../src/embeddings";
import { quasarMetricSnapshot, type MetricSnapshotEntry } from "../src/metrics";
import type { MappedSession } from "../src/model";
import { DurableQueue, Embeddings, makeDurableQueueLayer, type DurableQueueService } from "../src/services";
import { LocalStore, makeLocalStoreLayer } from "../src/store";
import {
  isAbortLikeError,
  makeSyntheticEmbedder,
  SYNTHETIC_TIMEOUT_OPERATION,
  SyntheticEmbeddingError,
} from "../src/syntheticEmbeddings";

const tempDirs: string[] = [];

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "quasar-embedding-observability-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const vector = (seed: number) => [seed === 0 ? 1 : 0, seed === 1 ? 1 : 0, seed === 2 ? 1 : 0];

const profile = (): EmbeddingProfile => makeEmbeddingProfile({
  model: "test-observability",
  dimensions: 3,
  task: "search_document",
});

const mappedSession = (text = "alpha terminal"): MappedSession => ({
  protocolVersion: "quasar.normalized-session/v1",
  project: { projectKey: "project-a", displayName: "Project A" },
  session: {
    sessionId: "session-a",
    projectKey: "project-a",
    provider: "codex",
    agentName: "codex",
    sourcePath: "/history/session-a.jsonl",
    sourceFingerprint: "fingerprint-a",
    host: "host-a",
    identitySchemeVersion: 1,
    normalizationVersion: 2,
    messageCount: 1,
    toolCallCount: 0,
  },
  messages: [{
    sessionId: "session-a",
    eventId: "event-1",
    seq: 1,
    role: "user",
    text,
    projectKey: "project-a",
    contentHash: "hash-a",
  }],
  toolCalls: [],
  events: [],
  usageRecords: [],
  sessionEdges: [],
  artifacts: [],
  executionContexts: [],
});

const withEmbeddings = <A>(
  embedder: Embedder,
  activeProfile: EmbeddingProfile,
  run: Effect.Effect<A, unknown, LocalStore | DurableQueue | Embeddings>,
  extras: ReadonlyArray<Layer.Layer<never>> = [],
) => {
  const sqlite = join(tempDir(), "quasar.sqlite");
  const dataLayer = makeLocalStoreLayer(sqlite);
  const queueLayer = makeDurableQueueLayer(sqlite);
  const embeddingsLayer = makeEmbeddingsLayer({
    sqlite,
    profile: activeProfile,
    embedder,
  }).pipe(Layer.provide(Layer.merge(dataLayer, queueLayer)));
  return Effect.runPromise(run.pipe(Effect.provide(Layer.mergeAll(dataLayer, queueLayer, embeddingsLayer, ...extras))));
};

const enqueueJob = (
  queue: DurableQueueService,
  options: {
    readonly sessionId?: string;
    readonly seq?: number;
    readonly contentHash?: string;
    readonly maxAttempts?: number;
    readonly idempotencyKey?: string;
    readonly embeddingProfile?: string;
  } = {},
) =>
  queue.enqueue({
    kind: "embed-message",
    payload: {
      sessionId: options.sessionId ?? "session-a",
      seq: options.seq ?? 1,
      contentHash: options.contentHash ?? "hash-a",
      embeddingProfile: options.embeddingProfile ?? profile().cacheNamespace,
    },
    idempotencyKey: options.idempotencyKey ?? `embed-message:${crypto.randomUUID()}`,
    maxAttempts: options.maxAttempts ?? 2,
  });

type CapturedLog = {
  readonly level: string;
  readonly message: string;
  readonly annotations: Record<string, unknown>;
};

const captureLogs = () => {
  const entries: CapturedLog[] = [];
  const logger = Logger.make((options) => {
    entries.push({
      level: options.logLevel.label,
      message: Array.isArray(options.message) ? options.message.map(String).join(" ") : String(options.message),
      annotations: Object.fromEntries(HashMap.toEntries(options.annotations)),
    });
  });
  return { entries, layer: Logger.replace(Logger.defaultLogger, logger) };
};

const capturedSpan = (spans: ReadonlyArray<{ name: string; attributes: Map<string, unknown> }>, name: string) =>
  spans.find((span) => span.name === name);

const makeCapturingTracer = () => {
  const spans: Array<{ name: string; attributes: Map<string, unknown> }> = [];
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind, options) => {
      const attributes = new Map<string, unknown>(
        options?.attributes === undefined ? [] : Object.entries(options.attributes),
      );
      const captured = { name, attributes };
      spans.push(captured);
      return {
        _tag: "Span",
        name,
        spanId: `span-${spans.length}`,
        traceId: "trace-1",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        sampled: true,
        kind,
        end: () => {},
        attribute: (key, value) => { attributes.set(key, value); },
        event: () => {},
        addLinks: () => {},
      };
    },
    context: (f) => f(),
  });
  return { spans, layer: Layer.setTracer(tracer) };
};

const embeddingOutcomeCount = (snapshot: readonly MetricSnapshotEntry[], outcome: string): number =>
  snapshot.find((entry) => entry.name === "quasar.embedding.worker.outcomes")?.occurrences?.[outcome] ?? 0;

const staleLeaseCount = (snapshot: readonly MetricSnapshotEntry[]): number =>
  snapshot.find((entry) => entry.name === "quasar.embedding.worker.stale_leases_recovered")?.count ?? 0;

describe("embedding failure classification", () => {
  test("distinguishes timeout, HTTP, decode and provider failures with preserved retry semantics", () => {
    const timeout = new SyntheticEmbeddingError({
      operation: SYNTHETIC_TIMEOUT_OPERATION,
      message: "Synthetic embeddings request exceeded 3000ms timeout",
      cause: new DOMException("The operation was aborted.", "AbortError"),
    });
    expect(classifyEmbeddingFailure(timeout)).toMatchObject({
      kind: "timeout",
      retryable: false,
      operation: SYNTHETIC_TIMEOUT_OPERATION,
    });

    const http = new SyntheticEmbeddingError({
      operation: "synthetic.embeddings",
      message: "server exploded",
      status: 503,
    });
    expect(classifyEmbeddingFailure(http)).toMatchObject({ kind: "http", retryable: true, status: 503 });

    const httpContract = new SyntheticEmbeddingError({
      operation: "synthetic.embeddings",
      message: "invalid api key",
      status: 401,
    });
    expect(classifyEmbeddingFailure(httpContract)).toMatchObject({ kind: "http", retryable: false, status: 401 });

    // Exact historical durable-worker delay class: 5xx outside 500/502/503/504 is not retry-classed.
    const httpOther = new SyntheticEmbeddingError({
      operation: "synthetic.embeddings",
      message: "not implemented",
      status: 501,
    });
    expect(classifyEmbeddingFailure(httpOther)).toMatchObject({ kind: "http", retryable: false, status: 501 });

    const decode = new SyntheticEmbeddingError({
      operation: "synthetic.embeddings.decode",
      message: "Synthetic embeddings response was not JSON",
    });
    expect(classifyEmbeddingFailure(decode)).toMatchObject({ kind: "decode", retryable: false });

    const provider = new SyntheticEmbeddingError({
      operation: "synthetic.embeddings",
      message: "SYNTHETIC_API_KEY is required for Synthetic embeddings",
    });
    expect(classifyEmbeddingFailure(provider)).toMatchObject({ kind: "provider", retryable: false });

    // Non-typed provider errors keep the historical message-regex delay class.
    expect(classifyEmbeddingFailure(new Error("rate limit exceeded"))).toMatchObject({
      kind: "provider",
      retryable: true,
    });
    expect(classifyEmbeddingFailure("boom")).toMatchObject({ kind: "unknown", retryable: false });
  });

  test("a bare abort is attributed as timeout, never the generic abort message", () => {
    const failure = classifyEmbeddingFailure(new DOMException("The operation was aborted.", "AbortError"));
    expect(failure.kind).toBe("timeout");
    expect(failure.message).not.toBe("The operation was aborted.");
    expect(failure.message).toMatch(/abort|timeout/i);
    expect(failure.cause).toBeInstanceOf(DOMException);
    expect(isAbortLikeError(failure.cause)).toBe(true);
  });
});

describe("synthetic request timeout typing", () => {
  test("wraps the internal abort in a typed timeout that keeps timeoutMs and cause", async () => {
    const previousTimeout = process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS;
    process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS = "20";
    let calls = 0;
    const hangingFetch: typeof fetch = (_input, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    };

    try {
      const result = await Effect.runPromise(
        makeSyntheticEmbedder(profile(), {
          apiKey: "test-key",
          fetch: hangingFetch,
        }).embedManyEffect!(["alpha terminal"]).pipe(Effect.either),
      );
      expect(result._tag).toBe("Left");
      if (result._tag !== "Left") throw new Error("expected synthetic timeout");
      const failure = result.left as SyntheticEmbeddingError;
      expect(failure).toBeInstanceOf(SyntheticEmbeddingError);
      expect(failure.operation).toBe(SYNTHETIC_TIMEOUT_OPERATION);
      expect(failure.message).toContain("20ms timeout");
      expect(failure.message).not.toBe("The operation was aborted.");
      expect(isAbortLikeError(failure.cause)).toBe(true);
      expect(classifyEmbeddingFailure(failure)).toMatchObject({ kind: "timeout", retryable: false });
      // Timeout behavior is unchanged: one in-client retry, then the typed timeout.
      expect(calls).toBe(2);
    } finally {
      if (previousTimeout === undefined) delete process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS;
      else process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS = previousTimeout;
    }
  });
});

describe("embedding worker structured logs", () => {
  test("retry and final failure logs carry job identity, attempt/max, duration and delay/error fields", async () => {
    const { entries, layer } = captureLogs();
    const failing: Embedder = {
      embedMany: async () => {
        throw new SyntheticEmbeddingError({
          operation: "synthetic.embeddings",
          message: "server exploded",
          status: 503,
        });
      },
    };

    const [first, second] = await withEmbeddings(
      failing,
      profile(),
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueJob(queue, { maxAttempts: 2 });
        const first = yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
        const second = yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:01:00.000Z",
        });
        return [first, second] as const;
      }),
      [layer],
    );

    expect(first).toMatchObject({ retried: 1, failed: 0 });
    expect(second).toMatchObject({ retried: 0, failed: 1 });

    const retryLog = entries.find((entry) => entry.message === "embedding.job.retry");
    expect(retryLog).toBeDefined();
    expect(retryLog?.annotations).toMatchObject({
      event: "embedding.job.retry",
      sessionId: "session-a",
      seq: 1,
      contentHash: "hash-a",
      attempt: 1,
      maxAttempts: 2,
      retryable: true,
      delayMs: 30_000,
      errorKind: "http",
      errorStatus: 503,
      errorMessage: "server exploded",
    });
    expect(typeof retryLog?.annotations.jobId).toBe("string");
    expect(typeof retryLog?.annotations.durationMs).toBe("number");

    const failureLog = entries.find((entry) => entry.message === "embedding.job.failed");
    expect(failureLog).toBeDefined();
    expect(failureLog?.annotations).toMatchObject({
      event: "embedding.job.failed",
      sessionId: "session-a",
      seq: 1,
      contentHash: "hash-a",
      attempt: 2,
      maxAttempts: 2,
      retryable: true,
      errorKind: "http",
      errorStatus: 503,
      errorMessage: "server exploded",
    });
    expect(typeof failureLog?.annotations.jobId).toBe("string");
    expect(typeof failureLog?.annotations.durationMs).toBe("number");
  });

  test("timeout failure logs are typed instead of the generic abort string", async () => {
    const { entries, layer } = captureLogs();
    const aborting: Embedder = {
      embedMany: async () => {
        throw new DOMException("The operation was aborted.", "AbortError");
      },
    };

    await withEmbeddings(
      aborting,
      profile(),
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        yield* enqueueJob(queue, { maxAttempts: 1 });
        yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
      }),
      [layer],
    );

    const failureLog = entries.find((entry) => entry.message === "embedding.job.failed");
    expect(failureLog).toBeDefined();
    expect(failureLog?.annotations.errorKind).toBe("timeout");
    expect(failureLog?.annotations.errorMessage).not.toBe("The operation was aborted.");
    expect(String(failureLog?.annotations.errorMessage)).toMatch(/abort|timeout/i);
    expect(failureLog?.annotations).toMatchObject({
      sessionId: "session-a",
      seq: 1,
      contentHash: "hash-a",
      attempt: 1,
      maxAttempts: 1,
    });
  });
});

describe("embedding worker metrics", () => {
  test("records embedded, skipped, cache and failure outcomes plus provider request duration", async () => {
    const before = await Effect.runPromise(quasarMetricSnapshot());
    const embedder: Embedder = { embedMany: async (values) => values.map((_, index) => vector(index)) };

    const [first, second] = await withEmbeddings(
      embedder,
      profile(),
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession({
          ...mappedSession("alpha terminal"),
          messages: [
            {
              sessionId: "session-a",
              eventId: "event-1",
              seq: 1,
              role: "user",
              text: "alpha terminal",
              projectKey: "project-a",
              contentHash: "hash-a",
            },
            {
              sessionId: "session-a",
              eventId: "event-2",
              seq: 2,
              role: "tool",
              text: "tool payload",
              projectKey: "project-a",
              contentHash: "hash-b",
            },
          ],
        });
        yield* enqueueJob(queue, { seq: 1, contentHash: "hash-a", idempotencyKey: "job-a" });
        yield* enqueueJob(queue, { seq: 2, contentHash: "hash-b", idempotencyKey: "job-b" });
        const first = yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
        // Same message again: cache hit, no provider call.
        yield* enqueueJob(queue, { seq: 1, contentHash: "hash-a", idempotencyKey: "job-c" });
        const second = yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:01:00.000Z",
        });
        return [first, second] as const;
      }),
    );

    expect(first).toMatchObject({ embedded: 1, skipped: 1, retried: 0, failed: 0 });
    expect(second).toMatchObject({ cacheHits: 1, embedded: 0 });

    const after = await Effect.runPromise(quasarMetricSnapshot());
    expect(embeddingOutcomeCount(after, "embedded") - embeddingOutcomeCount(before, "embedded")).toBe(1);
    expect(embeddingOutcomeCount(after, "skipped") - embeddingOutcomeCount(before, "skipped")).toBe(1);
    expect(embeddingOutcomeCount(after, "cache_miss") - embeddingOutcomeCount(before, "cache_miss")).toBe(1);
    expect(embeddingOutcomeCount(after, "cache_hit") - embeddingOutcomeCount(before, "cache_hit")).toBe(1);

    // Injected embedders do not emit provider duration; a synthetic provider does.
    const syntheticProfile = profile();
    const providerCalls: number[] = [];
    const successFetch: typeof fetch = async (_input, init) => {
      providerCalls.push(1);
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map((_, index) => ({ index, embedding: vector(0) })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const syntheticEmbedder = makeSyntheticEmbedder(syntheticProfile, {
      apiKey: "test-key",
      fetch: successFetch,
    });

    const beforeProvider = await Effect.runPromise(quasarMetricSnapshot());
    await withEmbeddings(
      syntheticEmbedder,
      syntheticProfile,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession("synthetic terminal"));
        yield* queue.enqueue({
          kind: "embed-message",
          payload: {
            sessionId: "session-a",
            seq: 1,
            contentHash: "hash-a",
            embeddingProfile: syntheticProfile.cacheNamespace,
          },
          idempotencyKey: "job-synthetic",
          maxAttempts: 1,
        });
        yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
      }),
    );

    const afterProvider = await Effect.runPromise(quasarMetricSnapshot());
    const timer = afterProvider.find((entry) => entry.name === "quasar.embedding.provider.request");
    expect(providerCalls.length).toBe(1);
    expect(timer?.kind).toBe("histogram");
    expect(timer?.tags).toContainEqual({ key: "provider", value: "synthetic" });
    const timerBefore = beforeProvider.find((entry) => entry.name === "quasar.embedding.provider.request");
    expect((timer?.count ?? 0) > (timerBefore?.count ?? 0)).toBe(true);
  });

  test("counts stale lease recovery performed by the worker", async () => {
    const before = await Effect.runPromise(quasarMetricSnapshot());
    const embedder: Embedder = { embedMany: async (values) => values.map((_, index) => vector(index)) };

    await withEmbeddings(
      embedder,
      profile(),
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession());
        const job = yield* enqueueJob(queue, { maxAttempts: 1 });
        const leased = yield* queue.leaseBatch({
          workerId: "worker-a",
          kind: "embed-message",
          limit: 10,
          leaseMs: 1,
          now: "2099-06-18T09:59:00.000Z",
        });
        expect(leased.length).toBe(1);
        yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
        expect(job.jobId).toBe(leased[0]?.jobId);
      }),
    );

    const after = await Effect.runPromise(quasarMetricSnapshot());
    expect(staleLeaseCount(after) - staleLeaseCount(before)).toBeGreaterThanOrEqual(1);
  });
});

describe("embedding worker spans", () => {
  test("batch, chunk and provider request spans carry only bounded safe attributes", async () => {
    const captured = makeCapturingTracer();
    const syntheticProfile = profile();
    const successFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { input: readonly string[] };
      return new Response(JSON.stringify({
        data: body.input.map((_, index) => ({ index, embedding: vector(0) })),
      }), { status: 200, headers: { "content-type": "application/json" } });
    };

    await withEmbeddings(
      makeSyntheticEmbedder(syntheticProfile, { apiKey: "test-key", fetch: successFetch }),
      syntheticProfile,
      Effect.gen(function* () {
        const store = yield* LocalStore;
        const queue = yield* DurableQueue;
        const embeddings = yield* Embeddings;
        yield* store.upsertSession(mappedSession("synthetic terminal"));
        yield* queue.enqueue({
          kind: "embed-message",
          payload: {
            sessionId: "session-a",
            seq: 1,
            contentHash: "hash-a",
            embeddingProfile: syntheticProfile.cacheNamespace,
          },
          idempotencyKey: "job-spans",
          maxAttempts: 1,
        });
        yield* embeddings.processBatch({
          workerId: "worker-a",
          limit: 10,
          leaseMs: 60_000,
          now: "2099-06-18T10:00:00.000Z",
        });
      }),
      [captured.layer],
    );

    const batch = capturedSpan(captured.spans, "embedding.worker.batch");
    expect(batch?.attributes.get("embedding.profile")).toBe(syntheticProfile.cacheNamespace);
    expect(batch?.attributes.get("embedding.provider")).toBe("injected");
    expect(batch?.attributes.get("embedding.worker")).toBe("worker-a");
    expect(batch?.attributes.get("embedding.batch.limit")).toBe(10);
    expect(batch?.attributes.get("embedding.batch.size")).toBe(1);
    expect(batch?.attributes.get("embedding.attempts")).toBe(1);
    expect(batch?.attributes.get("embedding.outcome")).toBe("ok");
    expect(batch?.attributes.get("embedding.embedded")).toBe(1);

    const chunk = capturedSpan(captured.spans, "embedding.worker.chunk");
    expect(chunk?.attributes.get("embedding.chunk.size")).toBe(1);
    expect(chunk?.attributes.get("embedding.outcome")).toBe("ok");

    const provider = capturedSpan(captured.spans, "embedding.provider.request");
    expect(provider?.attributes.get("embedding.provider")).toBe("synthetic");
    expect(provider?.attributes.get("embedding.model")).toBe(syntheticProfile.model);
    expect(provider?.attributes.get("embedding.batch.size")).toBe(1);
    expect(provider?.attributes.get("embedding.attempt")).toBe(1);
    expect(provider?.attributes.get("embedding.timeout_ms")).toBe(3_000);
    expect(provider?.attributes.get("embedding.outcome")).toBe("ok");

    const safeValues = [...captured.spans.flatMap((span) => [...span.attributes.values()])];
    for (const value of safeValues) {
      expect(typeof value === "string" || typeof value === "number" || typeof value === "boolean").toBe(true);
    }
    expect(safeValues).not.toContain("synthetic terminal");
  });
});
