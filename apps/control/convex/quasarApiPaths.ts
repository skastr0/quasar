const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const quasarApiPaths = {
  embeddingControl: pathFrom("api", "embeddings", "control"),
} as const;
