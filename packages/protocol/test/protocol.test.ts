import { describe, expect, test } from "bun:test";
import {
  QUERY_PROTOCOL_VERSION,
  QuerySpec,
  SESSION_ENRICHMENT_VERSION,
  decodeQueryResponseSync,
  decodeQuerySpecSync,
  decodeSessionEnrichmentSync,
  protocolContracts,
  protocolDiscovery,
  protocolExamples,
} from "../src/index";

const searchQuery = {
  protocolVersion: QUERY_PROTOCOL_VERSION,
  kind: "search",
  text: "model assignment",
  mode: "fusion",
  filters: {
    projectKey: "quasar",
    providers: ["codex"],
    agentRole: "codebase-archeologist",
    modelProvider: "openai",
  },
  projection: {
    detail: "summary",
    fields: ["sessionId", "provider", "text", "score"],
  },
  page: { limit: 25 },
} as const;

describe("QuerySpec v1", () => {
  test("accepts every registered query example", () => {
    for (const example of protocolContracts.query.examples) {
      expect(() => decodeQuerySpecSync(example.input)).not.toThrow();
    }
  });

  test("rejects unknown properties at every boundary", () => {
    expect(() => decodeQuerySpecSync({ ...searchQuery, surprise: true })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      filters: { ...searchQuery.filters, surprise: true },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      projection: { ...searchQuery.projection, surprise: true },
    })).toThrow();
  });

  test("rejects invalid kind-specific combinations", () => {
    expect(() => decodeQuerySpecSync({ ...searchQuery, text: "   " })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: { role: "assistant" },
      projection: { detail: "summary", fields: ["text"] },
      page: { limit: 10 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      text: "not valid for sessions",
      projection: { detail: "summary", fields: ["sessionId"] },
      page: { limit: 10 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        agentRole: "codebase-archeologist",
      },
      projection: { detail: "summary", fields: ["text"] },
      page: { limit: 10 },
    })).toThrow();
  });

  test("keeps assignment role distinct from message role", () => {
    const decoded = decodeQuerySpecSync(searchQuery);
    expect(decoded.kind).toBe("search");
    if (decoded.kind === "search") {
      expect(decoded.filters?.role).toBeUndefined();
      expect(decoded.filters?.agentRole).toBe("codebase-archeologist");
      expect(decoded.filters?.modelProvider).toBe("openai");
    }
  });

  test("accepts the normalized reasoning message role", () => {
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      filters: {
        sessionId: "codex:example-session",
        role: "reasoning",
      },
      projection: {
        detail: "summary",
        fields: ["messageId", "role", "text"],
      },
      page: { limit: 10 },
    })).not.toThrow();

    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "messages",
      projection: {
        detail: "summary",
        fields: ["messageId", "role", "text"],
      },
      page: { returned: 1 },
      items: [{
        messageId: "codex:message:reasoning",
        role: "reasoning",
        text: "private chain omitted; normalized reasoning summary retained",
      }],
    })).not.toThrow();
  });

  test("requires tool payload fields to use detail projection", () => {
    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: { detail: "summary", fields: ["toolCallId", "output"] },
      page: { limit: 10 },
    })).toThrow();

    expect(() => decodeQuerySpecSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: { detail: "detail", fields: ["toolCallId", "output"] },
      page: { limit: 10 },
    })).not.toThrow();
  });

  test("bounds pagination and projection", () => {
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 0 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 201 },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      projection: { detail: "summary", fields: ["text", "text"] },
    })).toThrow();
    expect(() => decodeQuerySpecSync({
      ...searchQuery,
      page: { limit: 10, cursor: "   " },
    })).toThrow();
  });

  test("publishes a closed JSON Schema", () => {
    const schema = protocolContracts.query.jsonSchema as {
      readonly $defs?: Record<string, unknown>;
      readonly anyOf?: ReadonlyArray<{ readonly additionalProperties?: boolean }>;
    };
    expect(schema.$defs).toBeDefined();
    expect(JSON.stringify(schema)).toContain('"additionalProperties":false');
    expect(QuerySpec.ast).toBeDefined();
  });
});

describe("QueryResponse v1", () => {
  test("accepts every registered response example", () => {
    for (const example of protocolContracts.response.examples) {
      expect(() => decodeQueryResponseSync(example.input)).not.toThrow();
    }
  });

  test("requires each row to match the selected fields exactly", () => {
    const response = protocolContracts.response.examples[0].input;
    expect(() => decodeQueryResponseSync(response)).not.toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], title: "not selected" }],
    })).toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      page: { ...response.page, returned: 2 },
    })).toThrow();
  });

  test("represents requested missing metadata as explicit null", () => {
    const response = {
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "sessions",
      projection: {
        detail: "detail",
        fields: [
          "sessionId",
          "title",
          "model",
          "modelProvider",
          "agentRole",
          "endedAt",
        ],
      },
      page: { returned: 1 },
      items: [{
        sessionId: "codex:example-session",
        title: null,
        model: null,
        modelProvider: null,
        agentRole: null,
        endedAt: null,
      }],
    } as const;

    expect(() => decodeQueryResponseSync(response)).not.toThrow();
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], sessionId: null }],
    })).toThrow();

    expect(() => decodeQueryResponseSync({
      protocolVersion: QUERY_PROTOCOL_VERSION,
      kind: "toolCalls",
      projection: {
        detail: "detail",
        fields: ["toolCallId", "model", "startedAt", "input", "output", "error"],
      },
      page: { returned: 1 },
      items: [{
        toolCallId: "call_example",
        model: null,
        startedAt: null,
        input: null,
        output: null,
        error: null,
      }],
    })).not.toThrow();
  });

  test("keeps tool bodies out of summary rows", () => {
    const response = protocolContracts.response.examples[1].input;
    expect(response.items[0].inputBytes).toBe(128);
    expect(response.items[0].outputBytes).toBe(2_048);
    expect("input" in response.items[0]).toBe(false);
    expect("output" in response.items[0]).toBe(false);
    expect(() => decodeQueryResponseSync({
      ...response,
      items: [{ ...response.items[0], output: "body" }],
    })).toThrow();
  });
});

describe("SessionEnrichment v1", () => {
  test("keeps derived analysis in a separate strict envelope", () => {
    const enrichment = protocolContracts.sessionEnrichment.examples[0].input;
    expect(() => decodeSessionEnrichmentSync(enrichment)).not.toThrow();
    expect(() => decodeSessionEnrichmentSync({
      ...enrichment,
      sourceFacts: { model: "must remain elsewhere" },
    })).toThrow();
    expect(() => decodeSessionEnrichmentSync({
      ...enrichment,
      payload: 1n,
    })).toThrow();
  });

  test("is discoverable from the same registry as query contracts", () => {
    expect(protocolDiscovery.map((entry) => entry.schemaId)).toEqual([
      QUERY_PROTOCOL_VERSION,
      "quasar.query-response/v1",
      SESSION_ENRICHMENT_VERSION,
    ]);
    expect(protocolExamples.length).toBe(7);
    expect(protocolExamples.every((example) => example.schemaId.length > 0)).toBe(true);
  });
});
