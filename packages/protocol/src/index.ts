import { JSONSchema, Schema } from "effect";

export const QUERY_PROTOCOL_VERSION = "quasar.query/v1" as const;
export const SESSION_ENRICHMENT_VERSION = "quasar.session-enrichment/v1" as const;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const boundedString = (identifier: string, maximumLength = 512) =>
  Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(maximumLength),
    Schema.filter((value) => value.trim().length > 0, {
      message: () => `${identifier} must not be blank`,
    }),
    Schema.annotations({ identifier }),
  );

const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);

const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
);

const ProjectKey = boundedString("QuasarProjectKey").pipe(
  Schema.brand("QuasarProjectKey"),
);

const SessionId = boundedString("QuasarSessionId").pipe(
  Schema.brand("QuasarSessionId"),
);

const MessageId = boundedString("QuasarMessageId").pipe(
  Schema.brand("QuasarMessageId"),
);

const ToolCallId = boundedString("QuasarToolCallId").pipe(
  Schema.brand("QuasarToolCallId"),
);

const OpaqueCursor = boundedString("QuasarOpaqueCursor", 4_096).pipe(
  Schema.brand("QuasarOpaqueCursor"),
);

const Provider = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "kimi",
  "hermes",
  "antigravity",
  "omp",
  "pi",
  "cursor",
  "devin",
  "amp",
).annotations({
  identifier: "QuasarProvider",
  description: "A provider supported by the Quasar query protocol v1.",
});

const SessionRole = Schema.Literal(
  "user",
  "assistant",
  "reasoning",
).annotations({ identifier: "QuasarSessionRole" });

const SearchMode = Schema.Literal("lexical", "semantic", "fusion")
  .annotations({ identifier: "QuasarSearchMode" });

const Timestamp = boundedString("QuasarTimestamp", 128).pipe(
  Schema.filter((value) => Number.isFinite(Date.parse(value)), {
    message: () => "Expected a valid timestamp",
  }),
  Schema.annotations({ jsonSchema: { format: "date-time" } }),
);

const ProviderList = Schema.Array(Provider).pipe(
  Schema.minItems(1),
  Schema.maxItems(Provider.literals.length),
  Schema.filter(
    (providers) => new Set(providers).size === providers.length,
    { message: () => "providers must not contain duplicates" },
  ),
);

const Model = boundedString("QuasarModel");
const ModelProvider = boundedString("QuasarModelProvider");
const AgentName = boundedString("QuasarAgentName");
const AgentRole = boundedString("QuasarAgentRole");
const ToolName = boundedString("QuasarToolName");
const ToolCallStatus = boundedString("QuasarToolCallStatus", 128);

const SearchFilters = Schema.Struct({
  projectKey: Schema.optional(ProjectKey),
  providers: Schema.optional(ProviderList),
  sessionId: Schema.optional(SessionId),
  role: Schema.optional(SessionRole),
  agentName: Schema.optional(AgentName),
  agentRole: Schema.optional(AgentRole),
  model: Schema.optional(Model),
  modelProvider: Schema.optional(ModelProvider),
});

const SessionFilters = Schema.Struct({
  projectKey: Schema.optional(ProjectKey),
  providers: Schema.optional(ProviderList),
  sessionId: Schema.optional(SessionId),
  agentName: Schema.optional(AgentName),
  agentRole: Schema.optional(AgentRole),
  model: Schema.optional(Model),
  modelProvider: Schema.optional(ModelProvider),
});

const MessageFilters = Schema.Struct({
  sessionId: SessionId,
  role: Schema.optional(SessionRole),
  model: Schema.optional(Model),
  modelProvider: Schema.optional(ModelProvider),
});

const ToolCallFilters = Schema.Struct({
  projectKey: Schema.optional(ProjectKey),
  providers: Schema.optional(ProviderList),
  sessionId: Schema.optional(SessionId),
  toolCallId: Schema.optional(ToolCallId),
  toolName: Schema.optional(ToolName),
  agentName: Schema.optional(AgentName),
  agentRole: Schema.optional(AgentRole),
  model: Schema.optional(Model),
  modelProvider: Schema.optional(ModelProvider),
});

const SearchSummaryField = Schema.Literal(
  "sessionId",
  "projectKey",
  "provider",
  "title",
  "role",
  "text",
  "score",
).annotations({ identifier: "QuasarSearchSummaryField" });

const SearchDetailField = Schema.Literal(
  ...SearchSummaryField.literals,
  "messageId",
  "sequence",
  "timestamp",
  "agentName",
  "agentRole",
  "model",
  "modelProvider",
  "contentHash",
  "textBytes",
  "textTruncated",
).annotations({ identifier: "QuasarSearchDetailField" });

const SessionSummaryField = Schema.Literal(
  "sessionId",
  "projectKey",
  "provider",
  "title",
  "startedAt",
  "endedAt",
).annotations({ identifier: "QuasarSessionSummaryField" });

const SessionDetailField = Schema.Literal(
  ...SessionSummaryField.literals,
  "agentName",
  "model",
  "modelProvider",
  "messageCount",
  "toolCallCount",
  "parentSessionId",
  "agentRole",
  "agentPath",
  "agentDepth",
  "sourcePath",
  "sourceFingerprint",
  "host",
  "identitySchemeVersion",
  "normalizationVersion",
).annotations({ identifier: "QuasarSessionDetailField" });

const MessageSummaryField = Schema.Literal(
  "messageId",
  "sessionId",
  "sequence",
  "role",
  "text",
  "timestamp",
).annotations({ identifier: "QuasarMessageSummaryField" });

const MessageDetailField = Schema.Literal(
  ...MessageSummaryField.literals,
  "projectKey",
  "provider",
  "agentName",
  "agentRole",
  "model",
  "modelProvider",
).annotations({ identifier: "QuasarMessageDetailField" });

const ToolCallSummaryField = Schema.Literal(
  "toolCallId",
  "sessionId",
  "projectKey",
  "provider",
  "sequence",
  "toolName",
  "timestamp",
  "status",
  "startedAt",
  "completedAt",
  "inputBytes",
  "outputBytes",
  "agentName",
  "model",
  "modelProvider",
).annotations({ identifier: "QuasarToolCallSummaryField" });

const ToolCallDetailField = Schema.Literal(
  ...ToolCallSummaryField.literals,
  "agentRole",
  "input",
  "output",
  "error",
).annotations({ identifier: "QuasarToolCallDetailField" });

const selectedFields = <A extends string, I, R>(
  field: Schema.Schema<A, I, R>,
) => {
  const fields = Schema.Array(field).pipe(
    Schema.minItems(1),
    Schema.maxItems(32),
  );
  return fields.pipe(Schema.filter(
    (values) => new Set(values).size === values.length,
    { message: () => "projection fields must not contain duplicates" },
  ));
};

const projection = <A extends string, I, R>(
  detail: "summary" | "detail",
  field: Schema.Schema<A, I, R>,
) => Schema.Struct({
  detail: Schema.Literal(detail),
  fields: selectedFields(field),
});

const SearchProjection = Schema.Union(
  projection("summary", SearchSummaryField),
  projection("detail", SearchDetailField),
).annotations({ identifier: "QuasarSearchProjection" });

const SessionProjection = Schema.Union(
  projection("summary", SessionSummaryField),
  projection("detail", SessionDetailField),
).annotations({ identifier: "QuasarSessionProjection" });

const MessageProjection = Schema.Union(
  projection("summary", MessageSummaryField),
  projection("detail", MessageDetailField),
).annotations({ identifier: "QuasarMessageProjection" });

const ToolCallProjection = Schema.Union(
  projection("summary", ToolCallSummaryField),
  projection("detail", ToolCallDetailField),
).annotations({
  identifier: "QuasarToolCallProjection",
  description: "Tool payload fields input, output, and error require detail projection.",
});

const QueryPage = Schema.Struct({
  limit: Schema.Number.pipe(Schema.int(), Schema.between(1, 200)),
  cursor: Schema.optional(OpaqueCursor),
}).annotations({ identifier: "QuasarQueryPage" });

const protocolVersion = Schema.Literal(QUERY_PROTOCOL_VERSION);

const SearchQuerySpec = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("search"),
  text: boundedString("QuasarSearchText", 4_096),
  mode: SearchMode,
  filters: Schema.optional(SearchFilters),
  projection: SearchProjection,
  page: QueryPage,
});

const SessionsQuerySpec = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("sessions"),
  filters: Schema.optional(SessionFilters),
  projection: SessionProjection,
  page: QueryPage,
});

const MessagesQuerySpec = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("messages"),
  filters: MessageFilters,
  projection: MessageProjection,
  page: QueryPage,
});

const ToolCallsQuerySpec = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("toolCalls"),
  filters: Schema.optional(ToolCallFilters),
  projection: ToolCallProjection,
  page: QueryPage,
});

export const QuerySpec = Schema.Union(
  SearchQuerySpec,
  SessionsQuerySpec,
  MessagesQuerySpec,
  ToolCallsQuerySpec,
).annotations({
  identifier: "QuasarQuerySpecV1",
  title: "Quasar QuerySpec v1",
  description: "One strict, bounded query contract shared by CLI, MCP, and HTTP adapters.",
  parseOptions: strictParseOptions,
});
export type QuerySpec = typeof QuerySpec.Type;
export type QuerySpecEncoded = typeof QuerySpec.Encoded;

export const decodeQuerySpec = Schema.decodeUnknown(QuerySpec, strictParseOptions);
export const decodeQuerySpecSync = Schema.decodeUnknownSync(QuerySpec, strictParseOptions);

type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

const JsonValue: Schema.Schema<JsonValue> = Schema.Union(
  Schema.Null,
  Schema.Boolean,
  Schema.JsonNumber,
  Schema.String,
  Schema.Array(Schema.suspend(() => JsonValue)),
  Schema.Record({
    key: Schema.String,
    value: Schema.suspend(() => JsonValue),
  }),
).annotations({
  identifier: "QuasarJsonValue",
  description: "A JSON-compatible value; functions, symbols, bigint, and undefined are rejected.",
});

const SearchItem = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  projectKey: Schema.optional(ProjectKey),
  provider: Schema.optional(Provider),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  role: Schema.optional(SessionRole),
  text: Schema.optional(Schema.String),
  score: Schema.optional(Schema.Number),
  messageId: Schema.optional(MessageId),
  sequence: Schema.optional(NonNegativeInteger),
  timestamp: Schema.optional(Schema.NullOr(Timestamp)),
  agentName: Schema.optional(Schema.NullOr(AgentName)),
  agentRole: Schema.optional(Schema.NullOr(AgentRole)),
  model: Schema.optional(Schema.NullOr(Model)),
  modelProvider: Schema.optional(Schema.NullOr(ModelProvider)),
  contentHash: Schema.optional(Schema.NullOr(Schema.String)),
  textBytes: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  textTruncated: Schema.optional(Schema.NullOr(Schema.Boolean)),
});

const SessionItem = Schema.Struct({
  sessionId: Schema.optional(SessionId),
  projectKey: Schema.optional(ProjectKey),
  provider: Schema.optional(Provider),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Timestamp)),
  endedAt: Schema.optional(Schema.NullOr(Timestamp)),
  agentName: Schema.optional(Schema.NullOr(AgentName)),
  model: Schema.optional(Schema.NullOr(Model)),
  modelProvider: Schema.optional(Schema.NullOr(ModelProvider)),
  messageCount: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  toolCallCount: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  parentSessionId: Schema.optional(Schema.NullOr(SessionId)),
  agentRole: Schema.optional(Schema.NullOr(AgentRole)),
  agentPath: Schema.optional(Schema.NullOr(boundedString("QuasarAgentPath", 2_048))),
  agentDepth: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  sourcePath: Schema.optional(Schema.NullOr(Schema.String)),
  sourceFingerprint: Schema.optional(Schema.NullOr(Schema.String)),
  host: Schema.optional(Schema.NullOr(Schema.String)),
  identitySchemeVersion: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  normalizationVersion: Schema.optional(Schema.NullOr(NonNegativeInteger)),
});

const MessageItem = Schema.Struct({
  messageId: Schema.optional(MessageId),
  sessionId: Schema.optional(SessionId),
  sequence: Schema.optional(NonNegativeInteger),
  role: Schema.optional(SessionRole),
  text: Schema.optional(Schema.String),
  timestamp: Schema.optional(Schema.NullOr(Timestamp)),
  projectKey: Schema.optional(ProjectKey),
  provider: Schema.optional(Provider),
  agentName: Schema.optional(Schema.NullOr(AgentName)),
  agentRole: Schema.optional(Schema.NullOr(AgentRole)),
  model: Schema.optional(Schema.NullOr(Model)),
  modelProvider: Schema.optional(Schema.NullOr(ModelProvider)),
});

const ToolCallItem = Schema.Struct({
  toolCallId: Schema.optional(ToolCallId),
  sessionId: Schema.optional(SessionId),
  projectKey: Schema.optional(ProjectKey),
  provider: Schema.optional(Provider),
  sequence: Schema.optional(NonNegativeInteger),
  toolName: Schema.optional(ToolName),
  timestamp: Schema.optional(Schema.NullOr(Timestamp)),
  status: Schema.optional(Schema.NullOr(ToolCallStatus)),
  startedAt: Schema.optional(Schema.NullOr(Timestamp)),
  completedAt: Schema.optional(Schema.NullOr(Timestamp)),
  inputBytes: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  outputBytes: Schema.optional(Schema.NullOr(NonNegativeInteger)),
  agentName: Schema.optional(Schema.NullOr(AgentName)),
  agentRole: Schema.optional(Schema.NullOr(AgentRole)),
  model: Schema.optional(Schema.NullOr(Model)),
  modelProvider: Schema.optional(Schema.NullOr(ModelProvider)),
  input: Schema.optional(JsonValue),
  output: Schema.optional(JsonValue),
  error: Schema.optional(JsonValue),
});

const ResponsePage = Schema.Struct({
  returned: NonNegativeInteger,
  nextCursor: Schema.optional(OpaqueCursor),
}).annotations({ identifier: "QuasarResponsePage" });

const responseMatchesProjection = (response: {
  readonly projection: { readonly fields: ReadonlyArray<string> };
  readonly page: { readonly returned: number };
  readonly items: ReadonlyArray<object>;
}) => {
  if (response.page.returned !== response.items.length) {
    return "page.returned must equal items.length";
  }

  const selected = [...response.projection.fields].sort();
  for (const item of response.items) {
    const returned = Object.keys(item).sort();
    if (selected.length !== returned.length
      || selected.some((field, index) => field !== returned[index])) {
      return "every item must contain exactly the selected projection fields";
    }
  }

  return true;
};

const SearchQueryResponse = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("search"),
  projection: SearchProjection,
  page: ResponsePage,
  items: Schema.Array(SearchItem),
}).pipe(Schema.filter(responseMatchesProjection));

const SessionsQueryResponse = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("sessions"),
  projection: SessionProjection,
  page: ResponsePage,
  items: Schema.Array(SessionItem),
}).pipe(Schema.filter(responseMatchesProjection));

const MessagesQueryResponse = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("messages"),
  projection: MessageProjection,
  page: ResponsePage,
  items: Schema.Array(MessageItem),
}).pipe(Schema.filter(responseMatchesProjection));

const ToolCallsQueryResponse = Schema.Struct({
  protocolVersion,
  kind: Schema.Literal("toolCalls"),
  projection: ToolCallProjection,
  page: ResponsePage,
  items: Schema.Array(ToolCallItem),
}).pipe(Schema.filter(responseMatchesProjection));

export const QueryResponse = Schema.Union(
  SearchQueryResponse,
  SessionsQueryResponse,
  MessagesQueryResponse,
  ToolCallsQueryResponse,
).annotations({
  identifier: "QuasarQueryResponseV1",
  title: "Quasar QueryResponse v1",
  description: "A paginated response whose rows contain exactly the requested fields.",
  parseOptions: strictParseOptions,
});
export type QueryResponse = typeof QueryResponse.Type;
export type QueryResponseEncoded = typeof QueryResponse.Encoded;

export const decodeQueryResponse = Schema.decodeUnknown(QueryResponse, strictParseOptions);
export const decodeQueryResponseSync = Schema.decodeUnknownSync(QueryResponse, strictParseOptions);

const EnrichmentNamespace = boundedString("QuasarEnrichmentNamespace", 128).pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._/-]*$/),
);
const Producer = boundedString("QuasarEnrichmentProducer", 256);
const InputHash = boundedString("QuasarEnrichmentInputHash", 256);

export const SessionEnrichment = Schema.Struct({
  protocolVersion: Schema.Literal(SESSION_ENRICHMENT_VERSION),
  sessionId: SessionId,
  namespace: EnrichmentNamespace,
  schemaVersion: PositiveInteger,
  producer: Producer,
  inputHash: InputHash,
  payload: JsonValue,
  updatedAt: Timestamp,
}).annotations({
  identifier: "QuasarSessionEnrichmentV1",
  title: "Quasar SessionEnrichment v1",
  description: "A namespaced derived-analysis envelope kept separate from provider source facts; source re-ingestion must not overwrite it.",
  parseOptions: strictParseOptions,
});
export type SessionEnrichment = typeof SessionEnrichment.Type;
export type SessionEnrichmentEncoded = typeof SessionEnrichment.Encoded;

export const decodeSessionEnrichment = Schema.decodeUnknown(SessionEnrichment, strictParseOptions);
export const decodeSessionEnrichmentSync = Schema.decodeUnknownSync(SessionEnrichment, strictParseOptions);

const queryExamples = [
  {
    name: "fusion search summary",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "search",
      text: "Codex model assignment loss",
      mode: "fusion",
      filters: {
        projectKey: "quasar",
        providers: ["codex"],
        agentRole: "codebase-archeologist",
        modelProvider: "openai",
      },
      projection: {
        detail: "summary",
        fields: ["sessionId", "provider", "title", "text", "score"],
      },
      page: { limit: 25 },
    },
  },
  {
    name: "session detail",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      filters: {
        providers: ["codex", "claude"],
        model: "gpt-5.6-sol",
        modelProvider: "openai",
        agentRole: "codebase-archeologist",
      },
      projection: {
        detail: "detail",
        fields: [
          "sessionId",
          "provider",
          "model",
          "modelProvider",
          "agentName",
          "agentRole",
        ],
      },
      page: { limit: 50 },
    },
  },
  {
    name: "session messages",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        role: "assistant",
        modelProvider: "openai",
      },
      projection: {
        detail: "detail",
        fields: [
          "messageId",
          "sequence",
          "role",
          "text",
          "model",
          "modelProvider",
          "agentRole",
        ],
      },
      page: { limit: 100 },
    },
  },
  {
    name: "tool payload detail",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      filters: {
        projectKey: "quasar",
        toolName: "exec_command",
        agentRole: "codebase-archeologist",
        modelProvider: "openai",
      },
      projection: {
        detail: "detail",
        fields: [
          "toolCallId",
          "sessionId",
          "toolName",
          "status",
          "inputBytes",
          "outputBytes",
          "agentRole",
          "modelProvider",
          "input",
          "output",
          "error",
        ],
      },
      page: { limit: 20 },
    },
  },
] as const;

const responseExamples = [
  {
    name: "search page",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "search",
      projection: {
        detail: "summary",
        fields: ["sessionId", "provider", "text", "score"],
      },
      page: { returned: 1, nextCursor: "opaque-next-page-token" },
      items: [{
        sessionId: "codex:example-session",
        provider: "codex",
        text: "Model selection lives in turn context.",
        score: 0.94,
      }],
    },
  },
  {
    name: "tool call summary without payloads",
    input: {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: {
        detail: "summary",
        fields: [
          "toolCallId",
          "sessionId",
          "toolName",
          "status",
          "startedAt",
          "completedAt",
          "inputBytes",
          "outputBytes",
        ],
      },
      page: { returned: 1 },
      items: [{
        toolCallId: "call_example",
        sessionId: "codex:example-session",
        toolName: "exec_command",
        status: "succeeded",
        startedAt: "2026-07-22T12:00:00.000Z",
        completedAt: "2026-07-22T12:00:00.250Z",
        inputBytes: 128,
        outputBytes: 2_048,
      }],
    },
  },
] as const;

const enrichmentExamples = [
  {
    name: "thread analysis",
    input: {
      protocolVersion: SESSION_ENRICHMENT_VERSION,
      sessionId: "codex:example-session",
      namespace: "quasar.analysis.thread-summary",
      schemaVersion: 1,
      producer: "thread-analyzer@1.0.0",
      inputHash: "sha256:example-source-fingerprint",
      payload: {
        summary: "The thread repaired Codex model fidelity.",
        topics: ["ingestion", "model metadata"],
      },
      updatedAt: "2026-07-22T12:00:00.000Z",
    },
  },
] as const;

const defineContract = <S extends Schema.Schema.All, const Examples extends ReadonlyArray<{
  readonly name: string;
  readonly input: unknown;
}>>(definition: {
  readonly schemaId: string;
  readonly title: string;
  readonly description: string;
  readonly schema: S;
  readonly examples: Examples;
}) => ({
  ...definition,
  jsonSchema: JSONSchema.make(Schema.asSchema(definition.schema), { target: "jsonSchema7" }),
});

export const protocolContracts = {
  query: defineContract({
    schemaId: QUERY_PROTOCOL_VERSION,
    title: "QuerySpec v1",
    description: "Strict, bounded query input shared by every Quasar transport.",
    schema: QuerySpec,
    examples: queryExamples,
  }),
  response: defineContract({
    schemaId: "quasar.query-response/v1",
    title: "QueryResponse v1",
    description: "Strict projected rows plus opaque cursor pagination.",
    schema: QueryResponse,
    examples: responseExamples,
  }),
  sessionEnrichment: defineContract({
    schemaId: SESSION_ENRICHMENT_VERSION,
    title: "SessionEnrichment v1",
    description: "Derived thread analysis isolated from re-ingestable source facts.",
    schema: SessionEnrichment,
    examples: enrichmentExamples,
  }),
} as const;

export const protocolDiscovery = Object.values(protocolContracts).map((contract) => ({
  schemaId: contract.schemaId,
  title: contract.title,
  description: contract.description,
  jsonSchema: contract.jsonSchema,
  examples: contract.examples.map((example) => example.name),
}));

export const protocolExamples = Object.values(protocolContracts).flatMap((contract) =>
  contract.examples.map((example) => ({
    schemaId: contract.schemaId,
    name: example.name,
    input: example.input,
  }))
);
