const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const quasarApiPaths = {
  ingestBatches: pathFrom("api", "ingest", "batches"),
  ingestJobs: pathFrom("api", "ingest", "jobs"),
  ingestJobsSchedule: pathFrom("api", "ingest", "jobs", "schedule"),
  ingestJobChunks: pathFrom("api", "ingest", ["job", "chunks"].join("-")),
  ingestJobChunksBulk: pathFrom("api", "ingest", ["job", "chunks", "bulk"].join("-")),
  embeddingControl: pathFrom("api", "embeddings", "control"),
} as const;
