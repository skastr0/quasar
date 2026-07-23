import { readFileSync } from "node:fs";

import {
  decodeQueryResponseSync,
  decodeQuerySpecSync,
  protocolContracts,
  protocolDiscovery,
  protocolExamples,
  type QueryResponse,
  type QuerySpec,
} from "@skastr0/quasar-protocol";

export interface QueryRequestOptions {
  readonly serverUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export class QueryTransportError extends Error {
  override readonly name = "QueryTransportError";
  readonly status: number;
  readonly details: unknown;

  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class QueryProtocolError extends Error {
  override readonly name = "QueryProtocolError";
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

export class QueryInputError extends Error {
  override readonly name = "QueryInputError";
  readonly details: unknown;

  constructor(message: string, details: unknown) {
    super(message);
    this.details = details;
  }
}

const queryUrl = (serverUrl: string): URL =>
  new URL("query", serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);

const errorMessage = (body: unknown, fallback: string): string => {
  if (typeof body !== "object" || body === null || !("error" in body)) return fallback;
  const error = (body as { readonly error?: unknown }).error;
  if (typeof error !== "object" || error === null || !("message" in error)) return fallback;
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.trim() !== "" ? message : fallback;
};

export const decodeQueryInput = (input: unknown): QuerySpec => decodeQuerySpecSync(input);

export const decodeQueryOutput = (input: unknown, expected?: QuerySpec): QueryResponse => {
  const response = decodeQueryResponseSync(input);
  if (expected !== undefined) {
    if (response.kind !== expected.kind) {
      throw new QueryProtocolError("query response kind does not match request", {
        expected: expected.kind,
        received: response.kind,
      });
    }
    if (JSON.stringify(response.projection) !== JSON.stringify(expected.projection)) {
      throw new QueryProtocolError("query response projection does not match request projection", {
        expected: expected.projection,
        received: response.projection,
      });
    }
  }
  return response;
};

export const runQuery = async (
  input: unknown,
  options: QueryRequestOptions,
): Promise<QueryResponse> => {
  const spec = decodeQueryInput(input);
  const response = await (options.fetchImpl ?? fetch)(queryUrl(options.serverUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(spec),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new QueryTransportError(
      response.status,
      errorMessage(body, `query request failed with HTTP ${response.status}`),
      body,
    );
  }
  return decodeQueryOutput(body, spec);
};

export const readQueryArgument = (source: string | undefined): QuerySpec => {
  if (source === undefined || source.trim() === "") {
    throw new QueryInputError("query requires <inline-json|@file|->", {
      expected: "inline JSON, @file, or - for stdin",
      received: source ?? null,
    });
  }
  const raw = source === "-"
    ? readFileSync(0, "utf8")
    : source.startsWith("@")
      ? readFileSync(source.slice(1), "utf8")
      : source;
  return decodeQueryInput(JSON.parse(raw) as unknown);
};

export type ProtocolContractName = keyof typeof protocolContracts;

const contractName = (name: string): ProtocolContractName | undefined => {
  const alias = name === "session-enrichment" ? "sessionEnrichment" : name;
  if (alias in protocolContracts) return alias as ProtocolContractName;
  return Object.entries(protocolContracts)
    .find(([, contract]) => contract.schemaId === name)?.[0] as ProtocolContractName | undefined;
};

export const protocolContract = (name?: string) => {
  if (name === undefined) return protocolDiscovery;
  const resolved = contractName(name);
  if (resolved === undefined) {
    throw new QueryInputError(`unknown schema ${name}`, {
      expected: ["query", "response", "session-enrichment"],
      received: name,
    });
  }
  const contract = protocolContracts[resolved];
  return {
    schemaId: contract.schemaId,
    title: contract.title,
    description: contract.description,
    jsonSchema: contract.jsonSchema,
  };
};

export const protocolExampleList = (name?: string) => {
  if (name === undefined) return protocolExamples;
  const resolved = contractName(name);
  const schemaId = resolved === undefined ? name : protocolContracts[resolved].schemaId;
  const matches = protocolExamples.filter((example) =>
    example.schemaId === schemaId || example.name === name,
  );
  if (matches.length === 0) {
    throw new QueryInputError(`unknown example or schema id: ${name}`, {
      expected: "a schema alias, schema id, or example name returned by `quasar examples`",
      received: name,
    });
  }
  return matches;
};
