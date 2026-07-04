import { env, pipeline } from "@huggingface/transformers";

import type { EmbeddingProfile } from "./embeddingProfiles";
import type { Embedder } from "./embeddings";

type FeatureExtractionOutput = {
  readonly dims?: readonly number[];
  readonly data?: ArrayLike<number>;
  readonly tolist?: () => unknown;
};

type FeatureExtractor = (
  values: string[],
  options: { readonly pooling: "mean"; readonly normalize: true },
) => Promise<FeatureExtractionOutput>;

export interface LocalOnnxEmbedderOptions {
  readonly cacheDir?: string;
  readonly dtype?: string;
  readonly pipelineFactory?: () => Promise<FeatureExtractor>;
}

const vectorFromUnknown = (value: unknown): readonly number[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const vector: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isFinite(item)) return undefined;
    vector.push(item);
  }
  return vector;
};

const vectorsFromOutput = (output: FeatureExtractionOutput, expected: number): readonly (readonly number[])[] => {
  const listed = output.tolist?.();
  if (expected === 1) {
    const single = vectorFromUnknown(listed);
    if (single !== undefined) return [single];
  }
  if (Array.isArray(listed)) {
    const vectors = listed.map(vectorFromUnknown);
    if (vectors.every((vector): vector is readonly number[] => vector !== undefined)) {
      return vectors;
    }
  }

  const dims = output.dims;
  const data = output.data;
  if (dims?.length === 2 && data !== undefined) {
    const rows = dims[0] ?? 0;
    const columns = dims[1] ?? 0;
    if (rows === expected && columns > 0 && data.length === rows * columns) {
      return Array.from({ length: rows }, (_, row) =>
        Array.from({ length: columns }, (_, column) => Number(data[row * columns + column])),
      );
    }
  }
  if (expected === 1 && dims?.length === 1 && data !== undefined && data.length === (dims[0] ?? -1)) {
    return [Array.from({ length: data.length }, (_, index) => Number(data[index]))];
  }
  throw new Error("local ONNX embedding output did not contain one vector per input");
};

const normalize = (vector: readonly number[]): readonly number[] => {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
};

const fitDimensions = (profile: EmbeddingProfile, vector: readonly number[]): readonly number[] => {
  if (vector.length === profile.dimensions) return vector;
  if (vector.length > profile.dimensions && profile.model.includes("nomic-embed-text-v1.5")) {
    return normalize(vector.slice(0, profile.dimensions));
  }
  throw new Error(`local ONNX embedding vector has dimension ${vector.length}; expected ${profile.dimensions}`);
};

const localModelId = (model: string): string =>
  model.startsWith("hf:") ? model.slice("hf:".length) : model;

export const makeLocalOnnxEmbedder = (
  profile: EmbeddingProfile,
  options: LocalOnnxEmbedderOptions = {},
): Embedder => {
  let extractorPromise: Promise<FeatureExtractor> | undefined;
  const load = async (): Promise<FeatureExtractor> => {
    if (extractorPromise !== undefined) return extractorPromise;
    if (options.cacheDir !== undefined && options.cacheDir.trim() !== "") {
      env.cacheDir = options.cacheDir;
    }
    extractorPromise = options.pipelineFactory?.() ?? (
      pipeline("feature-extraction", localModelId(profile.model), {
        dtype: options.dtype ?? process.env.QUASAR_EMBEDDING_ONNX_DTYPE?.trim() ?? "q8",
      } as never) as unknown as Promise<FeatureExtractor>
    );
    extractorPromise.catch(() => {
      extractorPromise = undefined;
    });
    return extractorPromise;
  };

  return {
    embedMany: async (values) => {
      if (values.length === 0) return [];
      const extractor = await load();
      const output = await extractor([...values], { pooling: "mean", normalize: true });
      const vectors = vectorsFromOutput(output, values.length);
      if (vectors.length !== values.length) {
        throw new Error(`local ONNX embedder returned ${vectors.length} vectors for ${values.length} inputs`);
      }
      return vectors.map((vector) => fitDimensions(profile, vector));
    },
  };
};
