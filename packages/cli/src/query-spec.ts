import { QUERY_PROTOCOL_VERSION, type QuerySpec } from "@skastr0/quasar-protocol";

import { decodeQueryInput } from "./query-client";

export type QueryDetail = "summary" | "detail";

export interface CommonQueryFilters {
  readonly projectKey?: string;
  readonly providers?: readonly string[];
  readonly sessionId?: string;
  readonly role?: string;
  readonly agentName?: string;
  readonly agentRole?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface QueryProjectionOptions {
  readonly detail?: QueryDetail;
  readonly fields?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

export const queryFields = {
  search: {
    summary: ["sessionId", "projectKey", "provider", "title", "role", "text", "score"],
    detail: [
      "sessionId", "projectKey", "provider", "title", "role", "text", "score",
      "messageId", "sequence", "timestamp", "agentName", "agentRole", "model", "modelProvider",
    ],
  },
  sessions: {
    summary: ["sessionId", "projectKey", "provider", "title", "startedAt", "endedAt"],
    detail: [
      "sessionId", "projectKey", "provider", "title", "startedAt", "endedAt", "agentName",
      "model", "modelProvider", "messageCount", "toolCallCount", "parentSessionId", "agentRole",
      "agentPath", "agentDepth",
    ],
  },
  messages: {
    summary: ["messageId", "sessionId", "sequence", "role", "text", "timestamp"],
    detail: [
      "messageId", "sessionId", "sequence", "role", "text", "timestamp", "projectKey", "provider",
      "agentName", "agentRole", "model", "modelProvider",
    ],
  },
  toolCalls: {
    summary: [
      "toolCallId", "sessionId", "projectKey", "provider", "sequence", "toolName", "timestamp",
      "status", "startedAt", "completedAt", "inputBytes", "outputBytes", "agentName", "model",
      "modelProvider",
    ],
    detail: [
      "toolCallId", "sessionId", "projectKey", "provider", "sequence", "toolName", "timestamp",
      "status", "startedAt", "completedAt", "inputBytes", "outputBytes", "agentName", "model",
      "modelProvider", "agentRole", "input", "output", "error",
    ],
  },
} as const;

const compact = (input: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));

const page = (options: QueryProjectionOptions, fallbackLimit: number) => compact({
  limit: options.limit ?? fallbackLimit,
  cursor: options.cursor,
});

const projection = <K extends keyof typeof queryFields>(
  kind: K,
  options: QueryProjectionOptions,
) => {
  const detail = options.detail ?? "summary";
  return {
    detail,
    fields: options.fields ?? queryFields[kind][detail],
  };
};

const searchFilters = (filters: CommonQueryFilters) => compact({
  projectKey: filters.projectKey,
  providers: filters.providers,
  sessionId: filters.sessionId,
  role: filters.role,
  agentName: filters.agentName,
  agentRole: filters.agentRole,
  model: filters.model,
  modelProvider: filters.modelProvider,
});

const sessionFilters = (filters: CommonQueryFilters) => compact({
  projectKey: filters.projectKey,
  providers: filters.providers,
  sessionId: filters.sessionId,
  agentName: filters.agentName,
  agentRole: filters.agentRole,
  model: filters.model,
  modelProvider: filters.modelProvider,
});

const toolCallFilters = (filters: CommonQueryFilters) => compact({
  projectKey: filters.projectKey,
  providers: filters.providers,
  sessionId: filters.sessionId,
  agentName: filters.agentName,
  agentRole: filters.agentRole,
  model: filters.model,
  modelProvider: filters.modelProvider,
  toolCallId: filters.toolCallId,
  toolName: filters.toolName,
});

export const searchQuery = (input: {
  readonly text: string;
  readonly mode: string;
  readonly filters?: CommonQueryFilters;
  readonly projection?: QueryProjectionOptions;
}): QuerySpec => decodeQueryInput({
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "search",
  text: input.text,
  mode: input.mode,
  filters: searchFilters(input.filters ?? {}),
  projection: projection("search", input.projection ?? {}),
  page: page(input.projection ?? {}, 50),
});

export const sessionsQuery = (input: {
  readonly filters?: CommonQueryFilters;
  readonly projection?: QueryProjectionOptions;
} = {}): QuerySpec => decodeQueryInput({
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "sessions",
  filters: sessionFilters(input.filters ?? {}),
  projection: projection("sessions", input.projection ?? {}),
  page: page(input.projection ?? {}, 100),
});

export const messagesQuery = (input: {
  readonly sessionId: string;
  readonly filters?: CommonQueryFilters;
  readonly projection?: QueryProjectionOptions;
}): QuerySpec => decodeQueryInput({
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "messages",
  filters: compact({
    sessionId: input.sessionId,
    role: input.filters?.role,
    model: input.filters?.model,
    modelProvider: input.filters?.modelProvider,
  }),
  projection: projection("messages", input.projection ?? {}),
  page: page(input.projection ?? {}, 100),
});

export const toolCallsQuery = (input: {
  readonly filters?: CommonQueryFilters;
  readonly projection?: QueryProjectionOptions;
} = {}): QuerySpec => decodeQueryInput({
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "toolCalls",
  filters: toolCallFilters(input.filters ?? {}),
  projection: projection("toolCalls", input.projection ?? {}),
  page: page(input.projection ?? {}, 100),
});
