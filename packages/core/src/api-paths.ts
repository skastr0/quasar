const pathFrom = (...parts: readonly string[]) => ["", ...parts].join("/");

export const QuasarApiPaths = {
  embeddingControl: pathFrom("api", "embeddings", "control"),
} as const;

export type QuasarApiPath = (typeof QuasarApiPaths)[keyof typeof QuasarApiPaths];
