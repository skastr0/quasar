export const GEMINI_EMBEDDING_MODEL_ID = "gemini-embedding-2";
export const SEARCH_EMBEDDING_DIMS = 1536;
export const GOOGLE_API_KEY_ENV = "GOOGLE_API_KEY";
export const GOOGLE_GENERATIVE_AI_API_KEY_ENV = "GOOGLE_GENERATIVE_AI_API_KEY";
export const GEMINI_EMBED_BATCH_MAX = 100;
export const INDEX_PAGE_SIZE = 100;

export const EMBEDDABLE_ROLES = ["user", "assistant"] as const;

export type EmbeddableRole = (typeof EMBEDDABLE_ROLES)[number];

export interface CurrentMessageForIndex {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: EmbeddableRole;
  readonly projectKey: string;
  readonly text: string;
}

export interface PlannedMessageRow extends CurrentMessageForIndex {
  readonly key: string;
  readonly contentHash: string;
}

export interface ExistingSearchRow {
  readonly key: string;
  readonly contentHash?: string;
}

export interface SessionIndexPlan {
  readonly currentRows: readonly PlannedMessageRow[];
  readonly rowsToEmbed: readonly PlannedMessageRow[];
  readonly keysToDelete: readonly string[];
  readonly messagesReused: number;
}

export type EmbeddingPurpose = "retrieval_query" | "retrieval_document";

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

export const messageSearchKey = (args: {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: EmbeddableRole;
}): string => `${args.sessionId}:${args.seq}:${args.role}`;

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

export const planSessionIndex = (args: {
  readonly currentMessages: readonly CurrentMessageForIndex[];
  readonly existingRows: readonly ExistingSearchRow[];
}): SessionIndexPlan => {
  const currentRows = args.currentMessages
    .filter((row) => row.text.trim().length > 0)
    .map((row) => ({
      ...row,
      key: messageSearchKey(row),
      contentHash: messageContentHash(row.text),
    }));
  const currentByKey = new Map(currentRows.map((row) => [row.key, row]));
  const existingByKey = new Map(args.existingRows.map((row) => [row.key, row]));
  const keysToDelete = args.existingRows
    .filter((row) => {
      const current = currentByKey.get(row.key);
      return current === undefined || current.contentHash !== row.contentHash;
    })
    .map((row) => row.key);
  const rowsToEmbed = currentRows.filter(
    (row) => existingByKey.get(row.key)?.contentHash !== row.contentHash,
  );
  return {
    currentRows,
    rowsToEmbed,
    keysToDelete,
    messagesReused: currentRows.length - rowsToEmbed.length,
  };
};
