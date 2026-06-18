import { Schema } from "effect";

import type { EmbeddingProfile } from "./embeddingProfiles";
import type { Embedder } from "./embeddings";

const DEFAULT_SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";

export class SyntheticEmbeddingError extends Schema.TaggedError<SyntheticEmbeddingError>()(
  "SyntheticEmbeddingError",
  {
    operation: Schema.String,
    message: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export interface SyntheticEmbeddingClientOptions {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

interface SyntheticEmbeddingData {
  readonly index: number;
  readonly embedding: readonly number[];
}

interface SyntheticEmbeddingResponse {
  readonly data?: readonly SyntheticEmbeddingData[];
}

const syntheticApiKeyFromEnv = (): string | undefined =>
  process.env.SYNTHETIC_API_KEY?.trim() || process.env.SYNTHETIC_NEW_API_KEY?.trim() || undefined;

const vectorFromUnknown = (value: unknown): readonly number[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === "number") ? value : undefined;

const dataFromUnknown = (value: unknown): readonly SyntheticEmbeddingData[] | undefined => {
  if (typeof value !== "object" || value === null || !("data" in value)) return undefined;
  const data = (value as SyntheticEmbeddingResponse).data;
  if (!Array.isArray(data)) return undefined;
  const parsed: SyntheticEmbeddingData[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) return undefined;
    const index = (item as { index?: unknown }).index;
    const embedding = vectorFromUnknown((item as { embedding?: unknown }).embedding);
    if (typeof index !== "number" || embedding === undefined) return undefined;
    parsed.push({ index, embedding });
  }
  return parsed;
};

export const makeSyntheticEmbedder = (profile: EmbeddingProfile, options: SyntheticEmbeddingClientOptions = {}): Embedder => ({
  embedMany: async (values) => {
    const apiKey = options.apiKey ?? syntheticApiKeyFromEnv();
    if (apiKey === undefined || apiKey.length === 0) {
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings",
        message: "SYNTHETIC_API_KEY is required for Synthetic embeddings",
      });
    }

    const baseUrl = options.baseUrl ?? process.env.SYNTHETIC_OPENAI_BASE_URL?.trim() ?? DEFAULT_SYNTHETIC_BASE_URL;
    const response = await (options.fetch ?? fetch)(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: profile.model,
        input: [...values],
        dimensions: profile.dimensions,
      }),
    });

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings.decode",
        message: "Synthetic embeddings response was not JSON",
        status: response.status,
        cause,
      });
    }

    if (!response.ok) {
      const message = typeof body === "object" && body !== null && "error" in body
        ? JSON.stringify((body as { error: unknown }).error)
        : `Synthetic embeddings request failed with HTTP ${response.status}`;
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings",
        message,
        status: response.status,
      });
    }

    const data = dataFromUnknown(body);
    if (data === undefined) {
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings.decode",
        message: "Synthetic embeddings response did not match expected shape",
      });
    }

    const vectors = new Array<readonly number[]>(values.length);
    for (const item of data) {
      vectors[item.index] = item.embedding;
    }
    if (vectors.some((vector) => vector === undefined)) {
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings.decode",
        message: "Synthetic embeddings response omitted one or more input indexes",
      });
    }
    return vectors;
  },
});
