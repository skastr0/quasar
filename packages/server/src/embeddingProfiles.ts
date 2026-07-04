import { createHash } from "node:crypto";

export interface EmbeddingProfile {
  readonly model: string;
  readonly dimensions: number;
  readonly task: string;
  readonly cacheNamespace: string;
  readonly documentPrefix?: string;
  readonly queryPrefix?: string;
}

export type EmbeddingProvider = "local" | "synthetic";

export class EmbeddingConfigurationError extends Error {
  override readonly name = "EmbeddingConfigurationError";
  readonly variable: string;
  readonly expected: readonly string[];
  readonly received: string;

  constructor(options: { readonly variable: string; readonly expected: readonly string[]; readonly received: string }) {
    super(`${options.variable} must be one of: ${options.expected.join(", ")}; got ${options.received}`);
    this.variable = options.variable;
    this.expected = options.expected;
    this.received = options.received;
  }
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

const sha256Short = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export const embeddingProviderFromEnv = (): EmbeddingProvider => {
  const raw = process.env.QUASAR_EMBEDDING_PROVIDER?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "local") return "local";
  if (raw === "synthetic") return "synthetic";
  throw new EmbeddingConfigurationError({
    variable: "QUASAR_EMBEDDING_PROVIDER",
    expected: ["local", "synthetic"],
    received: raw,
  });
};

const defaultCacheNamespaceFromEnv = (profile: Omit<EmbeddingProfile, "cacheNamespace">): string => {
  const provider = embeddingProviderFromEnv();
  if (provider === "synthetic") {
    const legacyDocumentPrefix = "search_document: ";
    const legacyQueryPrefix = "search_query: ";
    if (profile.documentPrefix !== legacyDocumentPrefix || profile.queryPrefix !== legacyQueryPrefix) {
      throw new EmbeddingConfigurationError({
        variable: "QUASAR_EMBEDDING_CACHE_NAMESPACE",
        expected: ["set explicitly when overriding Synthetic embedding prefixes"],
        received: `documentPrefix=${JSON.stringify(profile.documentPrefix ?? "")}, queryPrefix=${JSON.stringify(profile.queryPrefix ?? "")}`,
      });
    }
    return profileCacheNamespace(profile);
  }
  const onnxDtype = process.env.QUASAR_EMBEDDING_ONNX_DTYPE?.trim() || "q8";
  const fingerprint = sha256Short(JSON.stringify({
    version: 2,
    provider,
    onnxDtype: provider === "local" ? onnxDtype : undefined,
    documentPrefix: profile.documentPrefix ?? "",
    queryPrefix: profile.queryPrefix ?? "",
  }));
  return `${provider}:${profile.model}:${profile.dimensions}:${profile.task}:${fingerprint}`;
};

export const embeddingProfileFromEnv = (): EmbeddingProfile => {
  const model = process.env.QUASAR_EMBEDDING_MODEL?.trim() || "hf:nomic-ai/nomic-embed-text-v1.5";
  const profile = {
    model,
    dimensions: positiveIntEnv("QUASAR_EMBEDDING_DIMENSIONS", 768),
    task: process.env.QUASAR_EMBEDDING_TASK?.trim() || "search_document",
    documentPrefix: process.env.QUASAR_EMBEDDING_DOCUMENT_PREFIX ?? "search_document: ",
    queryPrefix: process.env.QUASAR_EMBEDDING_QUERY_PREFIX ?? "search_query: ",
  };
  return makeEmbeddingProfile({
    ...profile,
    cacheNamespace: process.env.QUASAR_EMBEDDING_CACHE_NAMESPACE?.trim() || defaultCacheNamespaceFromEnv(profile),
  });
};
