import { Effect, Layer, Ref } from "effect";

import { SearchMaintenance } from "./maintenance";
import { Embeddings, WorkerSupervisor, type WorkerSupervisorStatus } from "./services";

const envFlag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

const envFlagAny = (names: readonly string[], fallback: boolean): boolean => {
  for (const name of names) {
    const raw = process.env[name]?.trim();
    if (raw !== undefined && raw !== "") return envFlag(name, fallback);
  }
  return fallback;
};

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const renderError = (error: unknown): string => error instanceof Error ? error.message : String(error);
const reportLeased = (report: unknown): number =>
  typeof report === "object" && report !== null && typeof (report as { leased?: unknown }).leased === "number"
    ? (report as { leased: number }).leased
    : 0;

export const WorkerSupervisorLive = Layer.scoped(
  WorkerSupervisor,
  Effect.gen(function* () {
    const embeddings = yield* Embeddings;
    const maintenance = yield* SearchMaintenance;
    const enabled = envFlag("QUASAR_WORKERS_ENABLED", false);
    const intervalMs = envInt("QUASAR_WORKER_INTERVAL_MS", 5_000);
    const embeddingWorkerEnabled = envFlagAny(["QUASAR_EMBEDDING_WORKER_ENABLED", "QUASAR_EMBEDDINGS_WORKER_ENABLED"], enabled);
    const indexWorkerEnabled = envFlag("QUASAR_INDEX_REPAIR_WORKER_ENABLED", enabled);
    const freshnessWorkerEnabled = envFlag("QUASAR_FRESHNESS_WORKER_ENABLED", enabled);
    const maintenanceWorkerEnabled = envFlag("QUASAR_MAINTENANCE_WORKER_ENABLED", enabled);
    const workerConfigs = [
      { name: "embeddings", enabled: embeddingWorkerEnabled },
      { name: "index-repair", enabled: indexWorkerEnabled },
      { name: "freshness", enabled: freshnessWorkerEnabled },
      { name: "maintenance", enabled: maintenanceWorkerEnabled },
    ] as const;
    const workers = workerConfigs.filter((worker) => worker.enabled).map((worker) => worker.name);
    const state = yield* Ref.make<WorkerSupervisorStatus>({
      enabled: workers.length > 0,
      workers,
      lastReports: {},
      lastErrors: {},
    });

    const recordReport = (worker: string, report: unknown) =>
      Ref.update(state, (current) => ({
        ...current,
        lastReports: { ...current.lastReports, [worker]: report },
        lastErrors: Object.fromEntries(Object.entries(current.lastErrors).filter(([key]) => key !== worker)),
      }));

    const recordError = (worker: string, error: unknown) =>
      Ref.update(state, (current) => ({
        ...current,
        lastReports: Object.fromEntries(Object.entries(current.lastReports).filter(([key]) => key !== worker)),
        lastErrors: { ...current.lastErrors, [worker]: renderError(error) },
      }));

    const runWorker = (name: string, effect: Effect.Effect<unknown, unknown>) =>
      effect.pipe(
        Effect.tap((report) => recordReport(name, report)),
        Effect.catchAll((error) => recordError(name, error).pipe(Effect.as({ error: renderError(error) }))),
      );

    const embeddingOnce = () => embeddings.processBatch({
      workerId: "embedding-worker",
      limit: envInt("QUASAR_EMBEDDING_WORKER_LIMIT", 1_000),
      leaseMs: envInt("QUASAR_WORKER_LEASE_MS", 600_000),
    });
    const indexOnce = () => maintenance.repairOnce({
      workerId: "index-worker",
      limit: envInt("QUASAR_INDEX_WORKER_LIMIT", 100),
      leaseMs: envInt("QUASAR_WORKER_LEASE_MS", 600_000),
    });
    const freshnessOnce = () => maintenance.reconcileFreshness({
      limit: envInt("QUASAR_FRESHNESS_LIMIT", 500),
    });
    const maintenanceOnce = () => maintenance.maintain({
      includeVector: envFlag("QUASAR_MAINTENANCE_VECTOR", true),
      optimize: envFlag("QUASAR_MAINTENANCE_OPTIMIZE", true),
    });

    const anyWorkerEnabled = workerConfigs.some((worker) => worker.enabled);

    const tickOnce = Effect.gen(function* () {
      if (embeddingWorkerEnabled || !anyWorkerEnabled) yield* runWorker("embeddings", embeddingOnce());
      if (indexWorkerEnabled || !anyWorkerEnabled) yield* runWorker("index-repair", indexOnce());
      if (freshnessWorkerEnabled || !anyWorkerEnabled) yield* runWorker("freshness", freshnessOnce());
      if (maintenanceWorkerEnabled || !anyWorkerEnabled) yield* runWorker("maintenance", maintenanceOnce());
      return yield* Ref.get(state);
    });

    const loopWorker = (name: string, effect: () => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const report = yield* runWorker(name, effect());
        const delayMs = reportLeased(report) > 0 ? envInt("QUASAR_WORKER_BUSY_INTERVAL_MS", 100) : intervalMs;
        yield* Effect.sleep(`${delayMs} millis`);
      }).pipe(Effect.forever, Effect.forkScoped);

    if (embeddingWorkerEnabled) {
      yield* loopWorker("embeddings", embeddingOnce);
    }
    if (indexWorkerEnabled) {
      yield* loopWorker("index-repair", indexOnce);
    }
    if (freshnessWorkerEnabled) {
      yield* loopWorker("freshness", freshnessOnce);
    }
    if (maintenanceWorkerEnabled) {
      yield* loopWorker("maintenance", maintenanceOnce);
    }

    return WorkerSupervisor.of({
      status: Ref.get(state),
      tickOnce,
    });
  }),
);
