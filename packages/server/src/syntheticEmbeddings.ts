import { Schema } from "effect";

import type { EmbeddingProfile } from "./embeddingProfiles";
import type { Embedder } from "./embeddings";

const DEFAULT_SYNTHETIC_BASE_URL = "https://api.synthetic.new/openai/v1";
// Server-wide bound on every Synthetic call (query path AND document worker):
// 3s timeout + exactly one in-client retry. The durable queue remains the
// outer retry loop for document jobs; this inner retry only absorbs the known
// ~6% transient flake (truncated/malformed body, timeout, 5xx).
const DEFAULT_SYNTHETIC_REQUEST_TIMEOUT_MS = 3_000;
const SYNTHETIC_REQUEST_ATTEMPTS = 2;

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
  process.env.SYNTHETIC_API_KEY?.trim() || undefined;

const syntheticRequestTimeoutMs = (): number => {
  const raw = process.env.SYNTHETIC_EMBEDDING_TIMEOUT_MS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_SYNTHETIC_REQUEST_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SYNTHETIC_REQUEST_TIMEOUT_MS;
};

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

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

const validateResponseIndexes = (data: readonly SyntheticEmbeddingData[], expectedLength: number): void => {
  const seen = new Set<number>();
  for (const item of data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= expectedLength || seen.has(item.index)) {
      throw new SyntheticEmbeddingError({
        operation: "synthetic.embeddings.decode",
        message: `Synthetic embeddings response included invalid index ${item.index}`,
      });
    }
    seen.add(item.index);
  }
};

/** Truncated/malformed-body responses (the known ~6% flake), timeouts, and
 * 429/5xx are worth one in-client retry; auth/4xx contract errors are not. */
const isRetryableSyntheticFailure = (cause: unknown): boolean => {
  if (cause instanceof SyntheticEmbeddingError) {
    if (cause.operation === "synthetic.embeddings.decode") return true;
    return cause.status === 429 || (cause.status !== undefined && cause.status >= 500);
  }
  return true; // network error / abort (timeout)
};

const diagnostic = (event: string, fields: Record<string, unknown>): void => {
  console.error(JSON.stringify({ event, at: new Date().toISOString(), ...fields }));
};

const embedManyOnce = async (
  profile: EmbeddingProfile,
  options: SyntheticEmbeddingClientOptions,
  values: readonly string[],
  apiKey: string,
): Promise<readonly (readonly number[])[]> => {
  const baseUrl = options.baseUrl ?? process.env.SYNTHETIC_OPENAI_BASE_URL?.trim() ?? DEFAULT_SYNTHETIC_BASE_URL;
  const response = await fetchWithTimeout(options.fetch ?? fetch, `${baseUrl.replace(/\/$/, "")}/embeddings`, {
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
  }, syntheticRequestTimeoutMs());

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
  validateResponseIndexes(data, values.length);

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
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= SYNTHETIC_REQUEST_ATTEMPTS; attempt += 1) {
      try {
        return await embedManyOnce(profile, options, values, apiKey);
      } catch (cause) {
        lastFailure = cause;
        if (cause instanceof SyntheticEmbeddingError && cause.operation === "synthetic.embeddings.decode") {
          diagnostic("synthetic_embeddings.malformed_body", {
            attempt,
            status: cause.status,
            detail: cause.message,
          });
        }
        if (attempt < SYNTHETIC_REQUEST_ATTEMPTS && isRetryableSyntheticFailure(cause)) continue;
        throw cause;
      }
    }
    throw lastFailure;
  },
});
