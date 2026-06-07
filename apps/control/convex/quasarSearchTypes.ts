import type { Doc } from "./_generated/dataModel";
import type {
  ProviderSchema,
  SessionEventKindSchema,
  SessionRoleSchema,
} from "./quasarDomainSchemas";

export type SearchDocument = Doc<"searchDocuments">;
export type SearchDocumentInsert = Omit<SearchDocument, "_creationTime" | "_id">;

export type SearchFamily =
  | "sessions"
  | "sessionEvents"
  | "contentBlocks"
  | "toolCalls"
  | "artifacts"
  | "projectIdentities";

export type RagSyncState =
  | "pending"
  | "syncing"
  | "ready"
  | "skipped"
  | "failed"
  | "dead_letter";

export type SearchDocumentUpsertInput = Omit<
  SearchDocumentInsert,
  | "activeKind"
  | "activeMachine"
  | "activeProject"
  | "activeProvider"
  | "createdAt"
  | "ragContentHash"
  | "ragEntryId"
  | "ragError"
  | "ragSyncState"
  | "ragSyncedAt"
  | "searchTextHash"
  | "updatedAt"
> &
  Partial<
    Pick<
      SearchDocumentInsert,
      | "activeKind"
      | "activeMachine"
      | "activeProject"
      | "activeProvider"
      | "ragContentHash"
      | "ragEntryId"
      | "ragError"
      | "ragSyncState"
      | "ragSyncedAt"
      | "searchTextHash"
    >
  >;

export type SearchArgs = {
  query: string;
  projectIdentityKey?: string;
  machineId?: string;
  provider?: ProviderSchema;
  agentName?: string;
  role?: SessionRoleSchema;
  kind?: SessionEventKindSchema;
  toolName?: string;
  from?: string;
  to?: string;
  limit?: number;
};

export type SearchMatch = ReturnType<typeof baseMatchShape>;

export type SearchDiagnostics = {
  readonly textSearched: boolean;
  readonly semanticSearched: boolean;
  readonly semanticStatus?: string;
  readonly embeddingDimensions?: number;
  readonly readiness?: {
    readonly total: number;
    readonly pending: number;
    readonly syncing: number;
    readonly ready: number;
    readonly skipped: number;
    readonly failed: number;
    readonly deadLetter?: number;
  };
};

export type SearchResult = {
  readonly mode: "text" | "semantic" | "fusion";
  readonly query: string;
  readonly limit: number;
  readonly matches: SearchMatch[];
  readonly diagnostics: SearchDiagnostics;
};

export type RagSyncResult =
  | { readonly status: "missing" | "stale" | "skipped" | "failed" }
  | { readonly status: "ready"; readonly entryId?: string };

const baseMatchShape = (doc: SearchDocument, score: number) => ({
  searchDocumentId: doc.searchDocumentId,
  sourceTable: doc.sourceTable,
  sourceId: doc.sourceId,
  family: doc.family,
  title: doc.title,
  summary: doc.summary,
  projectIdentityKey: doc.canonicalProjectIdentityKey,
  machineId: doc.machineId,
  provider: doc.provider,
  agentName: doc.agentName,
  role: doc.role,
  kind: doc.kind,
  toolName: doc.toolName,
  occurredAt: doc.occurredAt,
  sourcePath: doc.sourcePath,
  sourceRef: doc.sourceRef,
  score,
});
