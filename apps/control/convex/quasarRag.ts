import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from "@ai-sdk/google";
import { defaultChunker, RAG, type InputChunk } from "@convex-dev/rag";
import {
  defaultEmbeddingSettingsMiddleware,
  embed,
  embedMany,
  wrapEmbeddingModel,
} from "ai";
import { Effect } from "effect";

import { components } from "./_generated/api";

export const QUASAR_RAG_NAMESPACE = "quasar-session-search";
export const QUASAR_EMBEDDING_MODEL_ID = "gemini-embedding-2";
export const QUASAR_EMBEDDING_DIMENSIONS = 1536;

const configuredApiKey = () =>
  process.env.GOOGLE_API_KEY ??
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
  process.env.GEMINI_API_KEY;

export const serverEmbeddingsConfigured = () => {
  const apiKey = configuredApiKey();
  return apiKey !== undefined && apiKey.trim().length > 0;
};

const google = createGoogleGenerativeAI({ apiKey: configuredApiKey() });

export const quasarEmbeddingModel = wrapEmbeddingModel({
  model: google.embedding(QUASAR_EMBEDDING_MODEL_ID),
  modelId: QUASAR_EMBEDDING_MODEL_ID,
  middleware: defaultEmbeddingSettingsMiddleware({
    settings: {
      providerOptions: {
        google: {
          outputDimensionality: QUASAR_EMBEDDING_DIMENSIONS,
        } satisfies GoogleEmbeddingModelOptions,
      },
    },
  }),
});

export type QuasarRagFilters = {
  canonicalProjectIdentityKey: string;
  machineId: string;
  provider: string;
};

export const quasarRag = new RAG<QuasarRagFilters>(components.rag, {
  textEmbeddingModel: quasarEmbeddingModel,
  embeddingDimension: QUASAR_EMBEDDING_DIMENSIONS,
  filterNames: ["canonicalProjectIdentityKey", "machineId", "provider"],
});

const requireApiKey = Effect.sync(() => {
  const apiKey = configuredApiKey();
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new Error(
      "GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, or GEMINI_API_KEY must be configured for Quasar embeddings.",
    );
  }
  return apiKey;
});

const embeddingInputFor = (args: {
  readonly purpose: "retrieval_document" | "retrieval_query";
  readonly text: string;
  readonly title?: string;
}) => {
  const text = args.text.trim();
  if (text.length === 0) throw new Error("Embedding text is required.");
  if (args.purpose === "retrieval_query") {
    return `task: retrieval_query | query: ${text}`;
  }
  return args.title === undefined || args.title.trim().length === 0
    ? `task: retrieval_document | text: ${text}`
    : `task: retrieval_document | title: ${args.title.trim()} | text: ${text}`;
};

export const embedQueryEffect = (query: string) =>
  Effect.gen(function* () {
    yield* requireApiKey;
    const result = yield* Effect.tryPromise({
      try: () =>
        embed({
          model: quasarEmbeddingModel,
          value: embeddingInputFor({ purpose: "retrieval_query", text: query }),
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    if (result.embedding.length !== QUASAR_EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding returned ${result.embedding.length} dimensions; expected ${QUASAR_EMBEDDING_DIMENSIONS}.`,
      );
    }
    return result.embedding;
  });

export const embedDocumentChunksEffect = (args: {
  readonly title: string;
  readonly text: string;
}) =>
  Effect.gen(function* () {
    yield* requireApiKey;
    const text = args.text.trim();
    if (text.length === 0) throw new Error("Embedding text is required.");
    const chunks = defaultChunker(text);
    const chunkTexts = chunks.length > 0 ? chunks : [text];
    const result = yield* Effect.tryPromise({
      try: () =>
        embedMany({
          model: quasarEmbeddingModel,
          values: chunkTexts.map((chunk) =>
            embeddingInputFor({
              purpose: "retrieval_document",
              title: args.title,
              text: chunk,
            }),
          ),
        }),
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    });
    return chunkTexts.map(
      (chunk, index): InputChunk => ({
        text: chunk,
        keywords: chunk,
        embedding: result.embeddings[index] ?? [],
      }),
    );
  });
