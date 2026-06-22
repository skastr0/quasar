import { Effect, Layer, Ref } from "effect";

import { SearchMaintenance } from "./maintenance";
import { Embeddings, WorkerSupervisor, type WorkerSupervisorStatus } from "./services";

// Tuning constants — no env overrides; workers always run.
const WORKER_IDLE_INTERVAL_MS = 5_000;
const WORKER_BUSY_INTERVAL_MS = 100;
const WORKER_LEASE_MS = 600_000;
const EMBEDDING_BATCH_LIMIT = 1_000;
const INDEX_BATCH_LIMIT = 100;

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

    const workers = ["embeddings", "index-repair", "maintenance"] as const;
    const state = yield* Ref.make<WorkerSupervisorStatus>({
      enabled: true,
      workers: [...workers],
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
      limit: EMBEDDING_BATCH_LIMIT,
      leaseMs: WORKER_LEASE_MS,
    });
    const indexOnce = () => maintenance.repairOnce({
      workerId: "index-worker",
      limit: INDEX_BATCH_LIMIT,
      leaseMs: WORKER_LEASE_MS,
    });
    const maintenanceOnce = () => maintenance.maintain();

    const tickOnce = Effect.gen(function* () {
      yield* runWorker("embeddings", embeddingOnce());
      yield* runWorker("index-repair", indexOnce());
      yield* runWorker("maintenance", maintenanceOnce());
      return yield* Ref.get(state);
    });

    const loopWorker = (name: string, effect: () => Effect.Effect<unknown, unknown>) =>
      Effect.gen(function* () {
        const report = yield* runWorker(name, effect());
        const delayMs = reportLeased(report) > 0 ? WORKER_BUSY_INTERVAL_MS : WORKER_IDLE_INTERVAL_MS;
        yield* Effect.sleep(`${delayMs} millis`);
      }).pipe(Effect.forever, Effect.forkScoped);

    yield* loopWorker("embeddings", embeddingOnce);
    yield* loopWorker("index-repair", indexOnce);
    yield* loopWorker("maintenance", maintenanceOnce);

    return WorkerSupervisor.of({
      status: Ref.get(state),
      tickOnce,
    });
  }),
);
