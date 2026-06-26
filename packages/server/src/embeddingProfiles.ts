export interface EmbeddingProfile {
  readonly model: string;
  readonly dimensions: number;
  readonly task: string;
  readonly cacheNamespace: string;
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;
}

export const makeEmbeddingProfile = (
  profile: Omit<EmbeddingProfile, "cacheNamespace"> & { readonly cacheNamespace?: string },
): EmbeddingProfile => ({
  ...profile,
  cacheNamespace: profile.cacheNamespace?.trim() || profileCacheNamespace(profile),
});

const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const profileCacheNamespace = (profile: Omit<EmbeddingProfile, "cacheNamespace">): string =>
  `synthetic:${profile.model}:${profile.dimensions}:${profile.task}`;

export const embeddingProfileJobNamespace = (profile: Pick<EmbeddingProfile, "cacheNamespace">): string =>
  profile.cacheNamespace;

export const embeddingProfileSearchTable = (profile: EmbeddingProfile): string =>
  `messages_${Buffer.from(profile.cacheNamespace).toString("base64url").slice(0, 24)}`;

export const embeddingProfileFromEnv = (): EmbeddingProfile => {
  const model = process.env.QUASAR_EMBEDDING_MODEL?.trim() || "hf:nomic-ai/nomic-embed-text-v1.5";
  return makeEmbeddingProfile({
    model,
    dimensions: positiveIntEnv("QUASAR_EMBEDDING_DIMENSIONS", 768),
    task: process.env.QUASAR_EMBEDDING_TASK?.trim() || "search_document",
    documentPrefix: process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX ?? "search_document: ",
    queryPrefix: process.env.QUASAR_EMBEDDING_QUERY_PREFIX ?? "search_query: ",
    cacheNamespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE?.trim() || undefined,
  });
};
