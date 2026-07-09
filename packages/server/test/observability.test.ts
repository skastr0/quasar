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

describe("observability metrics", () => {
  test("search stage timers and ingest frequencies appear in Metric.snapshot", async () => {
    const { Effect } = await import("effect");
    const {
      ALERT_RULES,
      HEALTHY_ENVELOPE,
      publishMatrixWatermarkGauges,
      publishQueueGauges,
      recordIngestOutcome,
      recordSearchReceiptMetrics,
      recordSyntheticMalformedBody,
      statusMetricsPayload,
    } = await import("../src/metrics");

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* recordSearchReceiptMetrics({
          mode: "semantic",
          readinessMs: 1,
          searchMs: 40,
          embedMs: 120,
          totalMs: 170,
        });
        yield* recordIngestOutcome({ status: "ok" });
        yield* recordIngestOutcome({
          status: "skipped",
          diagnostic: "unchanged_source_fingerprint",
        });
        yield* recordSyntheticMalformedBody();
        yield* publishQueueGauges({ pending: 2, leased: 1, failed: 0 });
        yield* publishMatrixWatermarkGauges({
          rows: 10,
          watermark: { matrixRows: 10, sqliteRows: 10 },
          overwrittenRows: 1,
          appendedRows: 9,
          droppedAppends: 0,
        });
      }),
    );

    const payload = await Effect.runPromise(statusMetricsPayload());
    const names = new Set(payload.snapshot.map((entry) => entry.name));

    expect(names.has("quasar.search.core")).toBe(true);
    expect(names.has("quasar.search.embed")).toBe(true);
    expect(names.has("quasar.search.total")).toBe(true);
    expect(names.has("quasar.search.readiness")).toBe(true);
    expect(names.has("quasar.ingest.outcomes")).toBe(true);
    expect(names.has("quasar.ingest.diagnostics")).toBe(true);
    expect(names.has("quasar.queue.pending")).toBe(true);
    expect(names.has("quasar.vector_matrix.watermark_drift")).toBe(true);
    expect(names.has("quasar.vector_matrix.overwrite_ratio")).toBe(true);
    expect(names.has("quasar.synthetic_embeddings.malformed_body")).toBe(true);

    const drift = payload.snapshot.find(
      (entry) => entry.name === "quasar.vector_matrix.watermark_drift",
    );
    expect(drift?.kind).toBe("gauge");
    expect(drift?.value).toBe(0);

    const ratio = payload.snapshot.find(
      (entry) => entry.name === "quasar.vector_matrix.overwrite_ratio",
    );
    expect(ratio?.value).toBeCloseTo(0.1, 5);

    // Healthy envelope + bench-gate alert rules ship with the snapshot payload.
    expect(payload.healthyEnvelope.watermarkDrift.healthy.maxAbs).toBe(0);
    expect(payload.alertRules.some((rule) => rule.id === "search.scan.p95")).toBe(true);
    expect(payload.alertRules.find((rule) => rule.id === "search.scan.p95")?.threshold).toBe(60);
    expect(payload.alertRules.find((rule) => rule.id === "search.embed.p50")?.threshold).toBe(150);
    expect(payload.alertRules.find((rule) => rule.id === "search.embed.p95")?.threshold).toBe(300);
    expect(payload.alertRules.find((rule) => rule.id === "search.warm.total.p95")?.threshold).toBe(100);
    expect(ALERT_RULES.length).toBeGreaterThanOrEqual(4);
    expect(HEALTHY_ENVELOPE.overwrite.metrics).toContain("quasar.vector_matrix.overwritten_rows");

    // Metric.timer records Duration inputs; a direct update is still a histogram.
    const core = payload.snapshot.find((entry) => entry.name === "quasar.search.core");
    expect(core?.kind).toBe("histogram");
    expect((core?.count ?? 0) >= 1).toBe(true);
  });

  test("nonzero watermark drift is visible on the gauge", async () => {
    const { Effect } = await import("effect");
    const { publishMatrixWatermarkGauges, quasarMetricSnapshot } = await import("../src/metrics");
    await Effect.runPromise(
      publishMatrixWatermarkGauges({
        rows: 8,
        watermark: { matrixRows: 8, sqliteRows: 10 },
        overwrittenRows: 0,
        appendedRows: 8,
        droppedAppends: 0,
      }),
    );
    const snap = await Effect.runPromise(quasarMetricSnapshot());
    const drift = snap.find((entry) => entry.name === "quasar.vector_matrix.watermark_drift");
    expect(drift?.value).toBe(2);
  });
});
