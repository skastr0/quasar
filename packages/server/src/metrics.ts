/**
 * Effect Metric re-homing for the local data plane.
 *
 * Timers track SearchReceipt stage legs. Gauges surface queue / readiness /
 * matrix watermark state for the live watch. Counters accumulate boundary
 * outcomes. Alert rules below are DEFINITIONS (structured thresholds), not a
 * live alerter — operators (or a future poller) compare Metric snapshot /
 * receipt histograms against them.
 *
 * When QUASAR_OTLP_BASE_URL is set, Otlp.layerJson already exports Effect
 * metrics on its metricsExportInterval; this module does not invent a second
 * export stack. /status always embeds a local Metric.snapshot regardless of
 * OTLP so the watch works with the collector off.
 *
 * ---------------------------------------------------------------------------
 * Healthy envelope — watermark drift + overwrite rate (customer #1 live watch)
 * ---------------------------------------------------------------------------
 *
 * Gauges:
 *   quasar.vector_matrix.ready            // 1 when resident matrix enabled
 *   quasar.vector_matrix.matrix_rows
 *   quasar.vector_matrix.sqlite_rows
 *   quasar.vector_matrix.watermark_drift   // abs(matrix_rows - sqlite_rows); -1 when not ready
 *   quasar.vector_matrix.overwritten_rows  // process-lifetime re-embed count
 *   quasar.vector_matrix.appended_rows
 *   quasar.vector_matrix.dropped_appends
 *   quasar.vector_matrix.overwrite_ratio   // overwritten / (appended+overwritten)
 *
 * watermark_drift:
 *   not ready — matrix empty/disabled: ready=0 and drift=-1 (WATERMARK_DRIFT_NOT_READY).
 *              Never treat empty-boot 0/0 as healthy lockstep.
 *   healthy  — ready=1 and drift=0 after boot load / applyVectorWrites for the
 *              active model (matrix and message_vectors stay lockstep).
 *   alert    — ready=1 and any nonzero drift. The matrix already logs
 *              vector_matrix.watermark_drift; the gauge makes it pollable on
 *              /status without scraping logs.
 *   critical — drift stays > 0 across successive /status polls for > 60s wall,
 *              OR |drift| grows without a matching append/boot (silent desync).
 *
 * overwrite_ratio / overwritten_rows:
 *   healthy  — overwrites rise only when an existing (sessionId, seq) is
 *              re-embedded after a real content change (or a force re-embed).
 *              A high ratio after a force materialize is still healthy.
 *   alert    — overwritten_rows climbing while appended_rows is flat AND no
 *              force re-embed is in flight (same keys thrashing). Ratio alone
 *              is not an alert; the delta vs append growth is.
 *   critical — not used. Overwrite is in-place update, never data loss.
 *
 * Numeric envelope constants live on HEALTHY_ENVELOPE so /status can surface
 * them next to the live gauges.
 */

import { Duration, Effect, Metric, MetricState, Option } from "effect";

// --- Search stage timers (SearchReceipt fields) -----------------------------

/** readinessMs — matrix status / semantic readiness probe. */
export const searchReadinessTimer = Metric.timer(
  "quasar.search.readiness",
  "Search readiness probe duration (ms histogram)",
);

/** searchMs — lexical scan / matrix scan + assemble. */
export const searchCoreTimer = Metric.timer(
  "quasar.search.core",
  "Search core duration: scan + assemble (ms histogram)",
);

/** embedMs — query embed. */
export const searchEmbedTimer = Metric.timer(
  "quasar.search.embed",
  "Query embed duration (ms histogram)",
);

/** totalMs — end-to-end route. */
export const searchTotalTimer = Metric.timer(
  "quasar.search.total",
  "End-to-end search route duration (ms histogram)",
);

// --- Gauges -----------------------------------------------------------------

export const queuePendingGauge = Metric.gauge("quasar.queue.pending", {
  description: "Durable queue jobs in pending status",
});
export const queueLeasedGauge = Metric.gauge("quasar.queue.leased", {
  description: "Durable queue jobs currently leased",
});
export const queueFailedGauge = Metric.gauge("quasar.queue.failed", {
  description: "Durable queue jobs in failed status",
});

/** 1 when the embedding readiness probe is ok, else 0. */
export const embeddingReadinessGauge = Metric.gauge("quasar.embedding.readiness", {
  description: "Embedding readiness probe ok (1) / not ok (0)",
});

/** 1 when the resident matrix is enabled (boot loaded rows), else 0. */
export const matrixReadyGauge = Metric.gauge("quasar.vector_matrix.ready", {
  description: "Resident matrix enabled for active model (1) / empty-or-disabled (0)",
});
export const matrixRowsGauge = Metric.gauge("quasar.vector_matrix.matrix_rows", {
  description: "Resident matrix row count for the active model",
});
export const matrixSqliteRowsGauge = Metric.gauge("quasar.vector_matrix.sqlite_rows", {
  description: "message_vectors row count for the active model (watermark peer)",
});
/**
 * abs(matrix_rows - sqlite_rows) when ready; WATERMARK_DRIFT_NOT_READY (-1)
 * when the matrix is empty/disabled so zero-drift is never a false healthy signal.
 */
export const matrixWatermarkDriftGauge = Metric.gauge("quasar.vector_matrix.watermark_drift", {
  description: "abs(matrix_rows - sqlite_rows) when ready; -1 when matrix not ready",
});

/** Sentinel for watermark_drift when matrix is empty/disabled (not evaluable as lockstep). */
export const WATERMARK_DRIFT_NOT_READY = -1;
export const matrixOverwrittenRowsGauge = Metric.gauge("quasar.vector_matrix.overwritten_rows", {
  description: "Process-lifetime in-place re-embeds of existing keys",
});
export const matrixAppendedRowsGauge = Metric.gauge("quasar.vector_matrix.appended_rows", {
  description: "Process-lifetime newly appended matrix rows",
});
export const matrixDroppedAppendsGauge = Metric.gauge("quasar.vector_matrix.dropped_appends", {
  description: "Appends dropped for capacity exhaustion",
});
/** overwritten / max(1, appended + overwritten); see HEALTHY_ENVELOPE. */
export const matrixOverwriteRatioGauge = Metric.gauge("quasar.vector_matrix.overwrite_ratio", {
  description: "overwritten_rows / (appended_rows + overwritten_rows)",
});

// --- Counters / frequencies -------------------------------------------------

/** Ingest boundary outcomes: ok | skipped | failed. */
export const ingestOutcomeFrequency = Metric.frequency(
  "quasar.ingest.outcomes",
  { description: "Ingest boundary outcomes by status" },
);

/** Named diagnostics on the ingest boundary (e.g. unchanged_source_fingerprint). */
export const ingestDiagnosticFrequency = Metric.frequency(
  "quasar.ingest.diagnostics",
  { description: "Named ingest-boundary diagnostics" },
);

export const appendRejectedCounter = Metric.counter("quasar.vector_matrix.append_rejected", {
  description: "Matrix appends rejected (dimension mismatch / non-finite)",
});
export const appendDroppedCounter = Metric.counter("quasar.vector_matrix.append_dropped", {
  description: "Matrix appends dropped (capacity exhausted)",
});

export const syntheticMalformedBodyCounter = Metric.counter(
  "quasar.synthetic_embeddings.malformed_body",
  { description: "Synthetic embedder truncated/malformed response bodies" },
);

// --- Healthy envelope (stated, pollable) ------------------------------------

export const HEALTHY_ENVELOPE = {
  watermarkDrift: {
    metric: "quasar.vector_matrix.watermark_drift",
    readyMetric: "quasar.vector_matrix.ready",
    notReadySentinel: WATERMARK_DRIFT_NOT_READY,
    /** Drift health is only defined when the resident matrix is enabled. */
    requires: {
      metric: "quasar.vector_matrix.ready",
      value: 1,
      note: "empty/disabled boot is not healthy lockstep; drift gauge is -1 until ready",
    },
    healthy: { maxAbs: 0 },
    alert: { minAbs: 1 },
    critical: {
      sustainedNonzeroMs: 60_000,
      note: "drift > 0 across successive /status polls for > 60s, or |drift| grows without append/boot",
    },
  },
  overwrite: {
    metrics: [
      "quasar.vector_matrix.overwritten_rows",
      "quasar.vector_matrix.appended_rows",
      "quasar.vector_matrix.overwrite_ratio",
    ],
    healthy: {
      note: "overwrites only on real re-embed of existing keys; high ratio after force materialize is ok",
    },
    alert: {
      note: "overwritten_rows rising while appended_rows flat and no force re-embed in flight",
    },
  },
} as const;

// --- Bench-gate thresholds → alert rule DEFINITIONS -------------------------
//
// Numbers match the live serving gates used in proofs/ops:
//   scan p95 < 60ms, embed p50 < 150 / p95 < 300, warm total < 100ms.
// These are structured definitions for operators / future pollers — not a
// live alerter process. Each rule names a concrete Metric.snapshot series
// (name + optional tags) so it is addressable without free-text guesswork.

/** Selects one series from Metric.snapshot / OTLP export. */
export type MetricSeriesSelector = {
  /** Exact Effect Metric name (`pair.metricKey.name`). */
  readonly name: string;
  /**
   * Exact tag match required. Omit for untagged series (global gauges /
   * counters). When present, every listed tag must appear on the series.
   */
  readonly tags?: ReadonlyArray<{ readonly key: string; readonly value: string }>;
};

export type AlertRulePrecondition = {
  readonly series: MetricSeriesSelector;
  readonly statistic: "value" | "count";
  readonly op: "eq" | "gt" | "gte" | "lt" | "lte";
  readonly threshold: number;
};

export type AlertRule = {
  readonly id: string;
  /** Concrete series this rule evaluates (name + optional tags). */
  readonly series: MetricSeriesSelector;
  readonly description: string;
  readonly statistic: "p50" | "p95" | "value" | "count";
  readonly op: "lt" | "lte" | "gt" | "gte" | "eq";
  readonly threshold: number;
  readonly unit: "ms" | "count" | "ratio" | "flag";
  readonly severity: "alert" | "critical";
  readonly source: string;
  /** When set, skip evaluation unless the precondition holds (e.g. matrix ready). */
  readonly when?: AlertRulePrecondition;
};

/** Semantic mode tag on search stage timers (`recordSearchReceiptMetrics`). */
const SEMANTIC_MODE_TAGS = [{ key: "mode", value: "semantic" }] as const;

export const ALERT_RULES: readonly AlertRule[] = [
  {
    id: "search.scan.p95",
    series: { name: "quasar.search.core", tags: SEMANTIC_MODE_TAGS },
    description: "Matrix scan + assemble p95 under 60ms (semantic mode)",
    statistic: "p95",
    op: "lt",
    threshold: 60,
    unit: "ms",
    severity: "alert",
    source: "bench-gate scan p95<60ms",
  },
  {
    id: "search.embed.p50",
    series: { name: "quasar.search.embed", tags: SEMANTIC_MODE_TAGS },
    description: "Query embed p50 under 150ms (semantic, novel / cold cache)",
    statistic: "p50",
    op: "lt",
    threshold: 150,
    unit: "ms",
    severity: "alert",
    source: "bench-gate embed p50<150ms",
  },
  {
    id: "search.embed.p95",
    series: { name: "quasar.search.embed", tags: SEMANTIC_MODE_TAGS },
    description: "Query embed p95 under 300ms (semantic mode)",
    statistic: "p95",
    op: "lt",
    threshold: 300,
    unit: "ms",
    severity: "alert",
    source: "bench-gate embed p95<300ms",
  },
  {
    id: "search.warm.total.p95",
    series: { name: "quasar.search.total", tags: SEMANTIC_MODE_TAGS },
    description: "Warm end-to-end search p95 under 100ms (semantic, embed cache hit)",
    statistic: "p95",
    op: "lt",
    threshold: 100,
    unit: "ms",
    severity: "alert",
    source: "bench-gate warm<100ms",
  },
  {
    id: "vector_matrix.watermark_drift",
    series: { name: "quasar.vector_matrix.watermark_drift" },
    description: "Matrix/SQLite watermark drift must stay at 0 when matrix is ready",
    statistic: "value",
    op: "eq",
    threshold: 0,
    unit: "count",
    severity: "alert",
    source: "healthy-envelope watermark_drift.maxAbs=0",
    when: {
      series: { name: "quasar.vector_matrix.ready" },
      statistic: "value",
      op: "eq",
      threshold: 1,
    },
  },
  {
    id: "vector_matrix.dropped_appends",
    series: { name: "quasar.vector_matrix.dropped_appends" },
    description: "Capacity-exhausted dropped appends should stay at 0",
    statistic: "value",
    op: "eq",
    threshold: 0,
    unit: "count",
    severity: "critical",
    source: "capacity guard",
    when: {
      series: { name: "quasar.vector_matrix.ready" },
      statistic: "value",
      op: "eq",
      threshold: 1,
    },
  },
] as const;

// --- Recording helpers ------------------------------------------------------

const millis = (ms: number): Duration.Duration =>
  Duration.millis(Math.max(0, Number.isFinite(ms) ? ms : 0));

export type SearchReceiptTimings = {
  readonly mode: "lexical" | "semantic" | "fusion";
  readonly readinessMs: number;
  readonly searchMs: number;
  readonly embedMs?: number;
  readonly totalMs: number;
};

/** Record SearchReceipt stage legs onto Effect Metric timers (mode-tagged). */
export const recordSearchReceiptMetrics = (
  receipt: SearchReceiptTimings,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const mode = receipt.mode;
    yield* Metric.update(
      Metric.tagged(searchReadinessTimer, "mode", mode),
      millis(receipt.readinessMs),
    );
    yield* Metric.update(
      Metric.tagged(searchCoreTimer, "mode", mode),
      millis(receipt.searchMs),
    );
    if (receipt.embedMs !== undefined) {
      yield* Metric.update(
        Metric.tagged(searchEmbedTimer, "mode", mode),
        millis(receipt.embedMs),
      );
    }
    yield* Metric.update(
      Metric.tagged(searchTotalTimer, "mode", mode),
      millis(receipt.totalMs),
    );
  });

export const recordIngestOutcome = (options: {
  readonly status: string;
  readonly diagnostic?: string;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Metric.update(ingestOutcomeFrequency, options.status);
    if (options.diagnostic !== undefined && options.diagnostic !== "") {
      yield* Metric.update(ingestDiagnosticFrequency, options.diagnostic);
    }
  });

export const recordAppendRejected = (): Effect.Effect<void> =>
  Metric.increment(appendRejectedCounter);

export const recordAppendDropped = (): Effect.Effect<void> =>
  Metric.increment(appendDroppedCounter);

export const recordSyntheticMalformedBody = (): Effect.Effect<void> =>
  Metric.increment(syntheticMalformedBodyCounter);

export const publishQueueGauges = (stats: {
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* Metric.set(queuePendingGauge, stats.pending);
    yield* Metric.set(queueLeasedGauge, stats.leased);
    yield* Metric.set(queueFailedGauge, stats.failed);
  });

/**
 * Process-local kinds last published as tagged queue gauges. `statsByKind`
 * only returns kinds with active pending/leased/failed rows — disappeared
 * kinds must be zeroed so /status does not leave stale non-zero per-kind
 * gauges from a prior poll.
 */
const publishedQueueKinds = new Set<string>();

/** Per-kind pending/leased/failed as tagged gauges (refreshed on /status). */
export const publishQueueKindGauges = (
  byKind: readonly {
    readonly kind: string;
    readonly pending: number;
    readonly leased: number;
    readonly failed: number;
  }[],
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const activeKinds = new Set(byKind.map((row) => row.kind));
    for (const kind of publishedQueueKinds) {
      if (activeKinds.has(kind)) continue;
      yield* Metric.set(Metric.tagged(queuePendingGauge, "kind", kind), 0);
      yield* Metric.set(Metric.tagged(queueLeasedGauge, "kind", kind), 0);
      yield* Metric.set(Metric.tagged(queueFailedGauge, "kind", kind), 0);
    }
    publishedQueueKinds.clear();
    for (const row of byKind) {
      publishedQueueKinds.add(row.kind);
      yield* Metric.set(Metric.tagged(queuePendingGauge, "kind", row.kind), row.pending);
      yield* Metric.set(Metric.tagged(queueLeasedGauge, "kind", row.kind), row.leased);
      yield* Metric.set(Metric.tagged(queueFailedGauge, "kind", row.kind), row.failed);
    }
  });

export const publishEmbeddingReadiness = (ok: boolean): Effect.Effect<void> =>
  Metric.set(embeddingReadinessGauge, ok ? 1 : 0);

export const publishMatrixWatermarkGauges = (status: {
  /** Resident matrix enabled (boot loaded rows). Required for honest drift. */
  readonly enabled: boolean;
  readonly rows: number;
  readonly watermark: { readonly matrixRows: number; readonly sqliteRows: number };
  readonly overwrittenRows: number;
  readonly appendedRows: number;
  readonly droppedAppends: number;
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const ready = status.enabled;
    const matrixRows = status.watermark.matrixRows;
    const sqliteRows = status.watermark.sqliteRows;
    // Empty/disabled matrix must not surface drift=0 as healthy lockstep.
    const drift = ready
      ? Math.abs(matrixRows - sqliteRows)
      : WATERMARK_DRIFT_NOT_READY;
    const totalWrites = status.appendedRows + status.overwrittenRows;
    const ratio = totalWrites === 0 ? 0 : status.overwrittenRows / totalWrites;
    yield* Metric.set(matrixReadyGauge, ready ? 1 : 0);
    yield* Metric.set(matrixRowsGauge, matrixRows);
    yield* Metric.set(matrixSqliteRowsGauge, sqliteRows);
    yield* Metric.set(matrixWatermarkDriftGauge, drift);
    yield* Metric.set(matrixOverwrittenRowsGauge, status.overwrittenRows);
    yield* Metric.set(matrixAppendedRowsGauge, status.appendedRows);
    yield* Metric.set(matrixDroppedAppendsGauge, status.droppedAppends);
    yield* Metric.set(matrixOverwriteRatioGauge, ratio);
  });

// --- Snapshot for /status ---------------------------------------------------

export type MetricSnapshotEntry = {
  readonly name: string;
  readonly description?: string;
  readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }>;
  readonly kind: "counter" | "gauge" | "histogram" | "frequency" | "summary" | "unknown";
  readonly count?: number;
  readonly value?: number;
  readonly sum?: number;
  readonly min?: number;
  readonly max?: number;
  readonly buckets?: ReadonlyArray<readonly [number | null, number]>;
  readonly occurrences?: Record<string, number>;
};

/** Locate a concrete series in a quasar Metric.snapshot (name + optional tags). */
export const selectMetricSeries = (
  snapshot: readonly MetricSnapshotEntry[],
  series: MetricSeriesSelector,
): MetricSnapshotEntry | undefined =>
  snapshot.find((entry) => {
    if (entry.name !== series.name) return false;
    const want = series.tags;
    if (want === undefined || want.length === 0) {
      return entry.tags.length === 0;
    }
    return want.every((tag) =>
      entry.tags.some((have) => have.key === tag.key && have.value === tag.value),
    );
  });

const isQuasarMetric = (name: string): boolean => name.startsWith("quasar.");

/** JSON-safe Metric.snapshot filtered to quasar.* (works with OTLP off). */
export const quasarMetricSnapshot = (): Effect.Effect<readonly MetricSnapshotEntry[]> =>
  Effect.map(Metric.snapshot, (pairs) =>
    pairs
      .filter((pair) => isQuasarMetric(pair.metricKey.name))
      .map((pair): MetricSnapshotEntry => {
        const name = pair.metricKey.name;
        const description = Option.getOrUndefined(pair.metricKey.description);
        const tags = pair.metricKey.tags.map((tag) => ({
          key: tag.key,
          value: tag.value,
        }));
        const state = pair.metricState;
        if (MetricState.isCounterState(state)) {
          return {
            name,
            description,
            tags,
            kind: "counter",
            count: Number(state.count),
          };
        }
        if (MetricState.isGaugeState(state)) {
          return {
            name,
            description,
            tags,
            kind: "gauge",
            value: Number(state.value),
          };
        }
        if (MetricState.isHistogramState(state)) {
          return {
            name,
            description,
            tags,
            kind: "histogram",
            count: state.count,
            sum: state.sum,
            min: state.min,
            max: state.max,
            buckets: state.buckets.map(([boundary, cumulative]) => [
              boundary,
              cumulative,
            ] as const),
          };
        }
        if (MetricState.isFrequencyState(state)) {
          return {
            name,
            description,
            tags,
            kind: "frequency",
            occurrences: Object.fromEntries(state.occurrences),
          };
        }
        if (MetricState.isSummaryState(state)) {
          return {
            name,
            description,
            tags,
            kind: "summary",
            count: state.count,
            sum: state.sum,
            min: state.min,
            max: state.max,
          };
        }
        return { name, description, tags, kind: "unknown" };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
  );

/** Payload fragment for /status — metrics + stated envelope + alert rules. */
export const statusMetricsPayload = (): Effect.Effect<{
  readonly snapshot: readonly MetricSnapshotEntry[];
  readonly healthyEnvelope: typeof HEALTHY_ENVELOPE;
  readonly alertRules: readonly AlertRule[];
}> =>
  Effect.map(quasarMetricSnapshot(), (snapshot) => ({
    snapshot,
    healthyEnvelope: HEALTHY_ENVELOPE,
    alertRules: ALERT_RULES,
  }));
