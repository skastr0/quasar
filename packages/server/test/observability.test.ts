import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

const repoRoot = join(import.meta.dir, "..", "..", "..");

/**
 * Stage-level span altitude and receipt traceId wiring.
 * Live warm-p95 re-receipt is deferred (no matrix + OTLP collector in unit CI).
 */
describe("observability OTLP env gate", () => {
  test("runtime gates Otlp.layerJson on QUASAR_OTLP_BASE_URL only", () => {
    const runtime = readFileSync(join(repoRoot, "packages/server/src/runtime.ts"), "utf8");
    expect(runtime).toContain("QUASAR_OTLP_BASE_URL");
    expect(runtime).toContain("Otlp.layerJson");
    expect(runtime).toContain("Layer.empty");
    expect(runtime).toContain('serviceName: "quasar-server"');
    // Empty/unset → no OTLP; set → export. No second enable flag in product code.
    expect(runtime).not.toContain("COMPOSE_PROFILES");
    expect(runtime).not.toContain("otel-lgtm");
  });

  test("compose OTLP base stays empty unless QUASAR_OTLP_BASE_URL is set", () => {
    const composeFile = join(repoRoot, "platform/server/compose.yaml");
    // Minimal env file — do not load platform/server/.env (secrets must not
    // appear in test failure dumps).
    const tmpEnv = join(repoRoot, "packages/server/test/.tmp-compose-otel.env");
    Bun.write(
      tmpEnv,
      [
        "QUASAR_INGEST_TOKEN=test-token-for-compose-config-only",
        "QUASAR_PUBLISH_HOST=127.0.0.1",
        "QUASAR_PUBLISH_PORT=7180",
        "",
      ].join("\n"),
    );
    const runConfig = (opts: {
      profiles?: string;
      otlpBaseUrl?: string;
    } = {}) => {
      const env: Record<string, string | undefined> = { ...process.env };
      delete env.COMPOSE_PROFILES;
      delete env.QUASAR_OTLP_BASE_URL;
      if (opts.profiles !== undefined) env.COMPOSE_PROFILES = opts.profiles;
      if (opts.otlpBaseUrl !== undefined) env.QUASAR_OTLP_BASE_URL = opts.otlpBaseUrl;
      return Bun.spawnSync(
        ["docker", "compose", "--env-file", tmpEnv, "-f", composeFile, "config"],
        { env, stdout: "pipe", stderr: "pipe" },
      );
    };

    try {
      const off = runConfig();
      expect(off.exitCode).toBe(0);
      const offText = off.stdout.toString();
      // Profiled image is not part of the rendered project when profile is off.
      expect(offText).not.toContain("grafana/otel-lgtm");
      expect(offText).toContain('QUASAR_OTLP_BASE_URL: ""');

      // Profile on alone starts the sink but does NOT invent the OTLP URL.
      const profileOnly = runConfig({ profiles: "otel" });
      expect(profileOnly.exitCode).toBe(0);
      const profileOnlyText = profileOnly.stdout.toString();
      expect(profileOnlyText).toContain("grafana/otel-lgtm");
      expect(profileOnlyText).toContain('QUASAR_OTLP_BASE_URL: ""');
      expect(profileOnlyText).not.toContain("http://otel-lgtm:4318");
      expect(profileOnlyText).toMatch(/profiles:[\s\S]*otel/);

      // Non-otel COMPOSE_PROFILES must not wire OTLP (the old ${:+} bug).
      const otherProfile = runConfig({ profiles: "debug" });
      expect(otherProfile.exitCode).toBe(0);
      const otherText = otherProfile.stdout.toString();
      expect(otherText).not.toContain("grafana/otel-lgtm");
      expect(otherText).toContain('QUASAR_OTLP_BASE_URL: ""');
      expect(otherText).not.toContain("http://otel-lgtm:4318");

      // Full enable: profile + explicit base URL.
      const full = runConfig({
        profiles: "otel",
        otlpBaseUrl: "http://otel-lgtm:4318",
      });
      expect(full.exitCode).toBe(0);
      const fullText = full.stdout.toString();
      expect(fullText).toContain("grafana/otel-lgtm");
      expect(fullText).toContain("http://otel-lgtm:4318");
    } finally {
      try {
        Bun.spawnSync(["rm", "-f", tmpEnv]);
      } catch {
        // ignore cleanup failures
      }
    }
  });
});

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
      selectMetricSeries,
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
          enabled: true,
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
    expect(names.has("quasar.vector_matrix.ready")).toBe(true);
    expect(names.has("quasar.vector_matrix.watermark_drift")).toBe(true);
    expect(names.has("quasar.vector_matrix.overwrite_ratio")).toBe(true);
    expect(names.has("quasar.synthetic_embeddings.malformed_body")).toBe(true);

    const drift = payload.snapshot.find(
      (entry) => entry.name === "quasar.vector_matrix.watermark_drift",
    );
    expect(drift?.kind).toBe("gauge");
    expect(drift?.value).toBe(0);

    const ready = payload.snapshot.find(
      (entry) => entry.name === "quasar.vector_matrix.ready",
    );
    expect(ready?.value).toBe(1);

    const ratio = payload.snapshot.find(
      (entry) => entry.name === "quasar.vector_matrix.overwrite_ratio",
    );
    expect(ratio?.value).toBeCloseTo(0.1, 5);

    // Healthy envelope + bench-gate alert rules ship with the snapshot payload.
    expect(payload.healthyEnvelope.watermarkDrift.healthy.maxAbs).toBe(0);
    expect(payload.healthyEnvelope.watermarkDrift.requires.value).toBe(1);
    expect(payload.alertRules.some((rule) => rule.id === "search.scan.p95")).toBe(true);
    expect(payload.alertRules.find((rule) => rule.id === "search.scan.p95")?.threshold).toBe(60);
    expect(payload.alertRules.find((rule) => rule.id === "search.embed.p50")?.threshold).toBe(150);
    expect(payload.alertRules.find((rule) => rule.id === "search.embed.p95")?.threshold).toBe(300);
    expect(payload.alertRules.find((rule) => rule.id === "search.warm.total.p95")?.threshold).toBe(100);
    expect(ALERT_RULES.length).toBeGreaterThanOrEqual(4);
    expect(HEALTHY_ENVELOPE.overwrite.metrics).toContain("quasar.vector_matrix.overwritten_rows");

    // Bench rules address concrete tagged series (evaluable against snapshot).
    const scanRule = ALERT_RULES.find((rule) => rule.id === "search.scan.p95");
    expect(scanRule?.series.name).toBe("quasar.search.core");
    expect(scanRule?.series.tags).toEqual([{ key: "mode", value: "semantic" }]);
    const selectedCore = selectMetricSeries(payload.snapshot, scanRule!.series);
    expect(selectedCore?.kind).toBe("histogram");
    expect((selectedCore?.count ?? 0) >= 1).toBe(true);

    const driftRule = ALERT_RULES.find((rule) => rule.id === "vector_matrix.watermark_drift");
    expect(driftRule?.when?.series.name).toBe("quasar.vector_matrix.ready");
    expect(selectMetricSeries(payload.snapshot, driftRule!.series)?.value).toBe(0);

    // Metric.timer records Duration inputs; a direct update is still a histogram.
    const core = payload.snapshot.find((entry) => entry.name === "quasar.search.core");
    expect(core?.kind).toBe("histogram");
    expect((core?.count ?? 0) >= 1).toBe(true);
  });

  test("nonzero watermark drift is visible on the gauge when ready", async () => {
    const { Effect } = await import("effect");
    const { publishMatrixWatermarkGauges, quasarMetricSnapshot } = await import("../src/metrics");
    await Effect.runPromise(
      publishMatrixWatermarkGauges({
        enabled: true,
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
    const ready = snap.find((entry) => entry.name === "quasar.vector_matrix.ready");
    expect(ready?.value).toBe(1);
  });

  test("empty/disabled matrix does not report healthy zero-drift", async () => {
    const { Effect } = await import("effect");
    const {
      HEALTHY_ENVELOPE,
      WATERMARK_DRIFT_NOT_READY,
      publishMatrixWatermarkGauges,
      quasarMetricSnapshot,
    } = await import("../src/metrics");

    await Effect.runPromise(
      publishMatrixWatermarkGauges({
        enabled: false,
        rows: 0,
        watermark: { matrixRows: 0, sqliteRows: 0 },
        overwrittenRows: 0,
        appendedRows: 0,
        droppedAppends: 0,
      }),
    );

    const snap = await Effect.runPromise(quasarMetricSnapshot());
    const ready = snap.find((entry) => entry.name === "quasar.vector_matrix.ready");
    const drift = snap.find((entry) => entry.name === "quasar.vector_matrix.watermark_drift");
    expect(ready?.value).toBe(0);
    expect(drift?.value).toBe(WATERMARK_DRIFT_NOT_READY);
    expect(drift?.value).not.toBe(0);
    // Envelope refuses to treat not-ready as healthy lockstep.
    expect(HEALTHY_ENVELOPE.watermarkDrift.notReadySentinel).toBe(WATERMARK_DRIFT_NOT_READY);
    expect(HEALTHY_ENVELOPE.watermarkDrift.requires.value).toBe(1);
  });

  test("queue kind gauges zero out kinds that disappear from statsByKind", async () => {
    const { Effect } = await import("effect");
    const { publishQueueKindGauges, quasarMetricSnapshot } = await import("../src/metrics");

    const kindTag = (entry: { tags: ReadonlyArray<{ key: string; value: string }> }, kind: string) =>
      entry.tags.some((tag) => tag.key === "kind" && tag.value === kind);

    await Effect.runPromise(
      publishQueueKindGauges([
        { kind: "embed-message", pending: 3, leased: 1, failed: 0 },
        { kind: "index-session", pending: 2, leased: 0, failed: 1 },
      ]),
    );

    let snap = await Effect.runPromise(quasarMetricSnapshot());
    const pendingEmbed = snap.find(
      (entry) => entry.name === "quasar.queue.pending" && kindTag(entry, "embed-message"),
    );
    const pendingIndex = snap.find(
      (entry) => entry.name === "quasar.queue.pending" && kindTag(entry, "index-session"),
    );
    expect(pendingEmbed?.value).toBe(3);
    expect(pendingIndex?.value).toBe(2);

    // Only embed-message remains active — index-session must reset to 0.
    await Effect.runPromise(
      publishQueueKindGauges([
        { kind: "embed-message", pending: 1, leased: 0, failed: 0 },
      ]),
    );

    snap = await Effect.runPromise(quasarMetricSnapshot());
    const pendingEmbedAfter = snap.find(
      (entry) => entry.name === "quasar.queue.pending" && kindTag(entry, "embed-message"),
    );
    const pendingIndexAfter = snap.find(
      (entry) => entry.name === "quasar.queue.pending" && kindTag(entry, "index-session"),
    );
    const leasedIndexAfter = snap.find(
      (entry) => entry.name === "quasar.queue.leased" && kindTag(entry, "index-session"),
    );
    const failedIndexAfter = snap.find(
      (entry) => entry.name === "quasar.queue.failed" && kindTag(entry, "index-session"),
    );
    expect(pendingEmbedAfter?.value).toBe(1);
    expect(pendingIndexAfter?.value).toBe(0);
    expect(leasedIndexAfter?.value).toBe(0);
    expect(failedIndexAfter?.value).toBe(0);
  });
});
