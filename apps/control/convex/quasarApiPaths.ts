const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const quasarApiPaths = {
  ingestBatches: pathFrom("api", "ingest", "batches"),
  ingestJobs: pathFrom("api", "ingest", "jobs"),
  ingestJobChunks: pathFrom("api", "ingest", ["job", "chunks"].join("-")),
  ingestJobChunksBulk: pathFrom("api", "ingest", ["job", "chunks", "bulk"].join("-")),
  embeddingControl: pathFrom("api", "embeddings", "control"),
} as const;
