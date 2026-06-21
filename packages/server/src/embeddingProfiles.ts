export type EmbeddingProvider = "gemini" | "synthetic";

export interface EmbeddingProfile {
  readonly provider: EmbeddingProvider;
  readonly model: string;
  readonly dimensions: number;
  readonly task: string;
  readonly cacheNamespace: string;
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;
}

const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_DIMENSIONS = 1536;
const DEFAULT_GEMINI_TASK = "SEMANTIC_SIMILARITY";

export const makeEmbeddingProfile = (profile: Omit<EmbeddingProfile, "cacheNamespace"> & { readonly cacheNamespace?: string }): EmbeddingProfile => ({
  ...profile,
  cacheNamespace: profile.cacheNamespace?.trim() || profileCacheNamespace(profile),
});

export const makeGeminiEmbeddingProfile = (overrides: Partial<Omit<EmbeddingProfile, "provider">> = {}): EmbeddingProfile => ({
  provider: "gemini",
  model: overrides.model ?? DEFAULT_GEMINI_MODEL,
  dimensions: overrides.dimensions ?? DEFAULT_GEMINI_DIMENSIONS,
  task: overrides.task ?? DEFAULT_GEMINI_TASK,
  cacheNamespace: overrides.cacheNamespace ?? overrides.model ?? DEFAULT_GEMINI_MODEL,
  documentPrefix: overrides.documentPrefix,
  queryPrefix: overrides.queryPrefix,
});

const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const profileCacheNamespace = (profile: Omit<EmbeddingProfile, "cacheNamespace">): string =>
  `${profile.provider}:${profile.model}:${profile.dimensions}:${profile.task}`;

export const embeddingProfileJobNamespace = (profile: Pick<EmbeddingProfile, "cacheNamespace">): string =>
  profile.cacheNamespace;

export const embeddingProfileSearchTable = (profile: EmbeddingProfile): string => {
  if (profile.provider === "gemini" && profile.cacheNamespace === profile.model) {
    return "messages";
  }
  return `messages_${Buffer.from(profile.cacheNamespace).toString("base64url").slice(0, 24)}`;
};

export const embeddingProfileFromEnv = (): EmbeddingProfile => {
  const provider = (process.env.QUASAR_EMBEDDING_PROVIDER?.trim() || "gemini") as EmbeddingProvider;
  if (provider === "synthetic") {
    const model = process.env.QUASAR_EMBEDDING_MODEL?.trim() || "hf:nomic-ai/nomic-embed-text-v1.5";
    const profile = {
      provider,
      model,
      dimensions: positiveIntEnv("QUASAR_EMBEDDING_DIMENSIONS", 768),
      task: process.env.QUASAR_EMBEDDING_TASK?.trim() || "search_document",
      documentPrefix: process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX ?? "search_document: ",
      queryPrefix: process.env.QUASAR_EMBEDDING_QUERY_PREFIX ?? "search_query: ",
    } satisfies Omit<EmbeddingProfile, "cacheNamespace">;
    return {
      ...profile,
      cacheNamespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE?.trim() || profileCacheNamespace(profile),
    };
  }

  const model = process.env.QUASAR_EMBEDDING_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  return makeGeminiEmbeddingProfile({
    model,
    dimensions: positiveIntEnv("QUASAR_EMBEDDING_DIMENSIONS", DEFAULT_GEMINI_DIMENSIONS),
    task: process.env.QUASAR_EMBEDDING_TASK?.trim() || DEFAULT_GEMINI_TASK,
    // Preserve the existing Gemini cache key by default; non-Gemini profiles use explicit provider namespaces.
    cacheNamespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE?.trim() || model,
  });
};
