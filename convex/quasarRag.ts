import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from "@ai-sdk/google";
import { RAG } from "@convex-dev/rag";
import { defaultEmbeddingSettingsMiddleware, wrapEmbeddingModel } from "ai";
import { components } from "./_generated/api";

/**
 * Embedding wiring for the conversation surface (user/assistant `messages`
 * rows ONLY — this module and `embed.ts` are pinned by the convex-lint
 * embedding-surface rule to never name the structural or reasoning surfaces).
 *
 * Model and dimensions follow the proven Gemini configuration already running
 * on this machine's other Convex projects (owner decision 2026-06-11).
 */
export const GEMINI_EMBEDDING_MODEL_ID = "gemini-embedding-2";
export const QUASAR_RAG_EMBEDDING_DIMENSIONS = 1536;
export const QUASAR_RAG_NAMESPACE = "quasar-search";
export const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY";
export const GOOGLE_GENERATIVE_AI_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";

/** Standard reciprocal-rank-fusion constant. */
export const RRF_K = 60;

/** Roles that exist on the embedding surface. */
export type EmbeddableRole = "user" | "assistant";

export type QuasarRagFilterSchemas = {
  projectKey: string;
  role: EmbeddableRole;
  projectKeyRole: string;
};

/** Entry metadata: enough to point straight back at the message row. */
export type QuasarRagMetadata = {
  sessionId: string;
  seq: number;
  role: EmbeddableRole;
  projectKey: string;
};

const configuredGoogleApiKey = () =>
  process.env[GOOGLE_API_KEY_ENV] ?? process.env[GOOGLE_GENERATIVE_AI_API_KEY_ENV];

export const serverEmbeddingsConfigured = () => {
  const apiKey = configuredGoogleApiKey();
  return apiKey !== undefined && apiKey.trim().length > 0;
};

const google = createGoogleGenerativeAI({ apiKey: configuredGoogleApiKey() });

export const quasarEmbeddingModel = wrapEmbeddingModel({
  model: google.embedding(GEMINI_EMBEDDING_MODEL_ID),
  modelId: GEMINI_EMBEDDING_MODEL_ID,
  middleware: defaultEmbeddingSettingsMiddleware({
    settings: {
      providerOptions: {
        google: {
          outputDimensionality: QUASAR_RAG_EMBEDDING_DIMENSIONS,
        } satisfies GoogleEmbeddingModelOptions,
      },
    },
  }),
});

export const quasarRag = new RAG<QuasarRagFilterSchemas, QuasarRagMetadata>(
  components.rag,
  {
    textEmbeddingModel: quasarEmbeddingModel,
    embeddingDimension: QUASAR_RAG_EMBEDDING_DIMENSIONS,
    filterNames: ["projectKey", "role", "projectKeyRole"],
  },
);

export type EmbeddingPurpose = "retrieval_query" | "retrieval_document";

/** Gemini task-prefixed embedding input (same convention as the proven
 * deployments on this machine). The stored chunk text stays raw — only the
 * embedding input carries the prefix. */
export const embeddingInputFor = (args: {
  readonly purpose: EmbeddingPurpose;
  readonly text: string;
}): string => {
  const text = args.text.trim();
  if (text.length === 0) {
    throw new Error("embeddingInputFor: embedding text is required");
  }
  return args.purpose === "retrieval_query"
    ? `task: retrieval_query | query: ${text}`
    : `task: retrieval_document | text: ${text}`;
};

/** Stable identity of a message row inside the RAG namespace. */
export const messageEntryKey = (args: {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: EmbeddableRole;
}): string => `${args.sessionId}:${args.seq}:${args.role}`;

/** FNV-1a content hash (two seeds + length) — lets the RAG component skip
 * re-embedding unchanged message text on session re-embeds. */
export const messageContentHash = (text: string): string => {
  const seeds = [0x811c9dc5, 0x01000193 ^ 0x811c9dc5] as const;
  const parts = seeds.map((seed) => {
    let hash = seed >>> 0;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  });
  return `${parts.join("")}:${text.length}`;
};

export const combinedProjectRoleValue = (
  projectKey: string,
  role: EmbeddableRole,
): string => `${projectKey}#${role}`;

// ---------------------------------------------------------------------------
// Pure search shaping (unit-tested; no Convex or network dependency)
// ---------------------------------------------------------------------------

/** A search hit pointing at one message row. */
export interface MessageMatch {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly text: string;
  readonly score: number;
  readonly textRank?: number;
  readonly vectorRank?: number;
}

export interface SemanticResultLike {
  readonly entryId: string;
  readonly score: number;
  readonly content: ReadonlyArray<{ readonly text: string }>;
}

export interface SemanticEntryLike {
  readonly entryId: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

const messageMetadataOf = (
  entry: SemanticEntryLike | undefined,
): QuasarRagMetadata | undefined => {
  const metadata = entry?.metadata;
  if (metadata === undefined) return undefined;
  const { sessionId, seq, role, projectKey } = metadata as Partial<QuasarRagMetadata>;
  return typeof sessionId === "string" &&
    typeof seq === "number" &&
    (role === "user" || role === "assistant") &&
    typeof projectKey === "string"
    ? { sessionId, seq, role, projectKey }
    : undefined;
};

/**
 * Maps RAG vector results back to message rows: joins each ranked chunk
 * result to its entry's message metadata, drops entries that do not carry
 * quasar message metadata, dedupes to the best-scoring hit per message row,
 * and assigns 1-based vector ranks.
 */
export const semanticMatchesFromSearch = (
  results: readonly SemanticResultLike[],
  entries: readonly SemanticEntryLike[],
  limit: number,
): MessageMatch[] => {
  const entriesById = new Map(entries.map((entry) => [entry.entryId, entry]));
  const best = new Map<string, MessageMatch>();
  for (const result of [...results].sort((a, b) => b.score - a.score)) {
    const metadata = messageMetadataOf(entriesById.get(result.entryId));
    if (metadata === undefined) continue;
    const key = messageEntryKey(metadata);
    const current = best.get(key);
    if (current !== undefined && current.score >= result.score) continue;
    best.set(key, {
      ...metadata,
      text: result.content.map((chunk) => chunk.text).join("\n"),
      score: result.score,
    });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match, index) => ({ ...match, vectorRank: index + 1 }));
};

export interface FusionSourceRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly text: string;
}

const fusionKey = (row: FusionSourceRow) => `${row.sessionId}:${row.seq}:${row.role}`;

/**
 * Standard reciprocal-rank fusion (k = 60): each list contributes
 * 1 / (k + rank) per message row; rows present in both lists sum their
 * contributions. Lexical text (the full stored row) wins over the semantic
 * chunk excerpt when both are present.
 */
export const fuseMatches = (args: {
  readonly lexical: readonly FusionSourceRow[];
  readonly semantic: readonly FusionSourceRow[];
  readonly limit: number;
}): MessageMatch[] => {
  const merged = new Map<string, MessageMatch>();
  args.lexical.forEach((row, index) => {
    const rank = index + 1;
    merged.set(fusionKey(row), {
      ...row,
      score: 1 / (RRF_K + rank),
      textRank: rank,
    });
  });
  args.semantic.forEach((row, index) => {
    const rank = index + 1;
    const key = fusionKey(row);
    const score = 1 / (RRF_K + rank);
    const current = merged.get(key);
    merged.set(
      key,
      current === undefined
        ? { ...row, score, vectorRank: rank }
        : { ...current, score: current.score + score, vectorRank: rank },
    );
  });
  return [...merged.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.seq - b.seq ||
        a.role.localeCompare(b.role),
    )
    .slice(0, args.limit);
};
