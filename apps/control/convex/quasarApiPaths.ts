const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const quasarApiPaths = {
  embeddingControl: pathFrom("api", "embeddings", "control"),
  ingestRecords: pathFrom("api", "ingest", "records"),
} as const;
