import { Effect, Layer, Ref } from "effect";

import { SearchMaintenance } from "./maintenance";
import { Embeddings, WorkerSupervisor, type WorkerSupervisorStatus } from "./services";

const envFlag = (name: string, fallback: boolean): boolean => {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
};

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const renderError = (error: unknown): string => error instanceof Error ? error.message : String(error);

export const WorkerSupervisorLive = Layer.scoped(
  WorkerSupervisor,
  Effect.gen(function* () {
    const embeddings = yield* Embeddings;
    const maintenance = yield* SearchMaintenance;
    const enabled = envFlag("QUASAR_WORKERS_ENABLED", false);
    const intervalMs = envInt("QUASAR_WORKER_INTERVAL_MS", 5_000);
    const workers = ["embeddings", "index-repair", "freshness", "maintenance"];
    const state = yield* Ref.make<WorkerSupervisorStatus>({
      enabled,
      workers: enabled ? workers : [],
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
        Effect.flatMap((report) => recordReport(name, report)),
        Effect.catchAll((error) => recordError(name, error)),
      );

    const tickOnce = Effect.gen(function* () {
      yield* runWorker("embeddings", embeddings.processBatch({
        workerId: "embedding-worker",
        limit: envInt("QUASAR_EMBEDDING_WORKER_LIMIT", 32),
        leaseMs: envInt("QUASAR_WORKER_LEASE_MS", 60_000),
      }));
      yield* runWorker("index-repair", maintenance.repairOnce({
        workerId: "index-worker",
        limit: envInt("QUASAR_INDEX_WORKER_LIMIT", 100),
        leaseMs: envInt("QUASAR_WORKER_LEASE_MS", 60_000),
      }));
      yield* runWorker("freshness", maintenance.reconcileFreshness({
        limit: envInt("QUASAR_FRESHNESS_LIMIT", 500),
      }));
      yield* runWorker("maintenance", maintenance.maintain({
        includeVector: envFlag("QUASAR_MAINTENANCE_VECTOR", true),
        optimize: envFlag("QUASAR_MAINTENANCE_OPTIMIZE", true),
      }));
      return yield* Ref.get(state);
    });

    if (enabled) {
      yield* tickOnce.pipe(
        Effect.delay(`${intervalMs} millis`),
        Effect.forever,
        Effect.forkScoped,
      );
    }

    return WorkerSupervisor.of({
      status: Ref.get(state),
      tickOnce,
    });
  }),
);
