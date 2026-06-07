const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const QuasarApiPaths = {
  ingestBatches: pathFrom("api", "ingest", "batches"),
  ingestJobs: pathFrom("api", "ingest", "jobs"),
  ingestJobChunks: pathFrom("api", "ingest", ["job", "chunks"].join("-")),
  ingestJobChunksBulk: pathFrom("api", "ingest", ["job", "chunks", "bulk"].join("-")),
  embeddingControl: pathFrom("api", "embeddings", "control"),
} as const;

export type QuasarApiPath = (typeof QuasarApiPaths)[keyof typeof QuasarApiPaths];
