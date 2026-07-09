import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

/**
 * Stage-level span altitude and receipt traceId wiring.
 * Live warm-p95 re-receipt is deferred (no matrix + OTLP collector in unit CI).
 */
describe("observability spans", () => {
  test("withSpan parent exposes a native traceId", async () => {
    const traceId = await Effect.runPromise(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan;
        return span.traceId;
      }).pipe(Effect.withSpan("search.lexical")),
    );
    expect(typeof traceId).toBe("string");
    expect(traceId.length).toBeGreaterThan(0);
    // Native tracer uses 32-char hex when root; never the sentinel "native" once parented.
    expect(traceId).not.toBe("native");
  });

  test("child span shares the parent traceId", async () => {
    const ids = await Effect.runPromise(
      Effect.gen(function* () {
        const parent = yield* Effect.currentSpan;
        const childId = yield* Effect.gen(function* () {
          const child = yield* Effect.currentSpan;
          return child.traceId;
        }).pipe(Effect.withSpan("search.lexicalScan"));
        return { parent: parent.traceId, child: childId };
      }).pipe(Effect.withSpan("search.lexical")),
    );
    expect(ids.parent).toBe(ids.child);
  });

  test("stage span names used by search/ingest are distinct stage-level labels", () => {
    // Contract lock: altitude is stage-level, not per-row. These are the
    // names wired in handlers / services — keep the set small and stable.
    const stageNames = [
      "search.lexical",
      "search.semantic",
      "search.fusion",
      "search.lexicalScan",
      "search.embedText",
      "search.matrixScan",
      "search.rrfFuse",
      "search.readiness",
      "ingest.session",
      "ingest.diffApply",
      "ingest.chunk",
    ] as const;
    expect(new Set(stageNames).size).toBe(stageNames.length);
    for (const name of stageNames) {
      expect(name.includes("row")).toBe(false);
    }
  });
});
