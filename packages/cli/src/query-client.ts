import { createHash } from "node:crypto";
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

export interface FetchRequestOptions {
  readonly timeoutMs: number;
  readonly fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

export interface QueryRequestOptions extends FetchRequestOptions {
  readonly serverUrl: string;
}

export interface QueryResourceRequest {
  readonly path: string;
  readonly params: Readonly<Record<string, string | number>>;
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

export class FetchTransportError extends Error {
  override readonly name = "FetchTransportError";
  readonly url: string;
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(url: URL, attempts: number, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`request failed after ${attempts} attempt${attempts === 1 ? "" : "s"}: ${causeMessage}`);
    this.url = url.toString();
    this.attempts = attempts;
    this.cause = cause;
  }
}

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

type JsonRecord = Record<string, unknown>;

interface QueryCursorPayload {
  readonly version: 1;
  readonly kind: QuerySpec["kind"];
  readonly fingerprint: string;
  readonly offset: number;
}

const isRecord = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const queryFingerprint = (spec: QuerySpec): string => {
  const page = { limit: spec.page.limit };
  return createHash("sha256")
    .update(JSON.stringify({ ...spec, page }))
    .digest("base64url");
};

const encodeCursor = (spec: QuerySpec, offset: number): string =>
  Buffer.from(JSON.stringify({
    version: 1,
    kind: spec.kind,
    fingerprint: queryFingerprint(spec),
    offset,
  } satisfies QueryCursorPayload), "utf8").toString("base64url");

const decodeCursor = (spec: QuerySpec): number => {
  const cursor = spec.page.cursor;
  if (cursor === undefined) return 0;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new QueryInputError("query cursor is malformed", {
      cursor,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !isRecord(payload)
    || payload.version !== 1
    || payload.kind !== spec.kind
    || payload.fingerprint !== queryFingerprint(spec)
    || !Number.isSafeInteger(payload.offset)
    || (payload.offset as number) < 0
  ) {
    throw new QueryInputError("query cursor does not match the query shape", {
      expectedKind: spec.kind,
      cursor,
    });
  }
  return payload.offset as number;
};

const compactParams = (
  input: Record<string, string | number | undefined>,
): Record<string, string | number> =>
  Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string | number] =>
    entry[1] !== undefined));

const resourceFilters = (
  filters: Readonly<Record<string, unknown>> | undefined,
): Record<string, string | number> => compactParams({
  projectKey: typeof filters?.projectKey === "string" ? filters.projectKey : undefined,
  provider: Array.isArray(filters?.providers) ? filters.providers.join(",") : undefined,
  sessionId: typeof filters?.sessionId === "string" ? filters.sessionId : undefined,
  role: typeof filters?.role === "string" ? filters.role : undefined,
  agentName: typeof filters?.agentName === "string" ? filters.agentName : undefined,
  agentRole: typeof filters?.agentRole === "string" ? filters.agentRole : undefined,
  model: typeof filters?.model === "string" ? filters.model : undefined,
  modelProvider: typeof filters?.modelProvider === "string" ? filters.modelProvider : undefined,
  toolName: typeof filters?.toolName === "string" ? filters.toolName : undefined,
});

const toolCallBodyFields = new Set(["input", "output", "error"]);

export const queryResourceRequest = (input: unknown): QueryResourceRequest => {
  const spec = decodeQueryInput(input);
  const offset = decodeCursor(spec);
  const filters = spec.filters as Readonly<Record<string, unknown>> | undefined;
  const params = {
    ...resourceFilters(filters),
    limit: spec.page.limit,
    offset,
  };

  switch (spec.kind) {
    case "sessions":
      return { path: "sessions", params };
    case "messages":
      return { path: "messages", params };
    case "search":
      return {
        path: `search/${spec.mode}`,
        params: { ...params, q: spec.text },
      };
    case "toolCalls": {
      const toolCallId = typeof filters?.toolCallId === "string"
        ? filters.toolCallId
        : undefined;
      if (toolCallId !== undefined) {
        return { path: "tool-call", params: { id: toolCallId } };
      }
      const requestedBodies = spec.projection.fields.filter((field) =>
        toolCallBodyFields.has(field));
      if (requestedBodies.length > 0) {
        throw new QueryInputError(
          "tool-call payload fields require filters.toolCallId",
          {
            fields: requestedBodies,
            hint: "Fetch one tool call by id; bulk tool-call resources never return payload bodies.",
          },
        );
      }
      return { path: "tool-calls", params };
    }
  }
};

const requireRecord = (value: unknown, message: string): JsonRecord => {
  if (!isRecord(value)) throw new QueryProtocolError(message, value);
  return value;
};

const requireRows = (value: unknown, message: string): readonly JsonRecord[] => {
  if (!Array.isArray(value) || value.some((row) => !isRecord(row))) {
    throw new QueryProtocolError(message, value);
  }
  return value as readonly JsonRecord[];
};

const resourcePage = (
  value: unknown,
  spec: QuerySpec,
  expectedOffset: number,
): { readonly nextOffset: number | null } => {
  const page = requireRecord(value, "resource response data.page must be an object");
  if (
    page.limit !== spec.page.limit
    || page.offset !== expectedOffset
    || !(page.nextOffset === null
      || (Number.isSafeInteger(page.nextOffset)
        && (page.nextOffset as number) > expectedOffset))
  ) {
    throw new QueryProtocolError("resource response page does not match the request", {
      expected: { limit: spec.page.limit, offset: expectedOffset },
      received: page,
    });
  }
  return { nextOffset: page.nextOffset as number | null };
};

const payloadValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

const normalizeSearchMatch = (match: JsonRecord): JsonRecord => {
  const row = requireRecord(match.row, "search match row must be an object");
  return {
    ...row,
    messageId: row.messageId ?? match.key,
    sequence: row.sequence ?? row.seq,
    score: match.score,
    // `row.text` is the server-bounded excerpt. Never hydrate or expand it here.
    text: row.text,
  };
};

const normalizeToolCall = (row: JsonRecord): JsonRecord => ({
  ...row,
  input: payloadValue(row.input ?? row.inputText),
  output: payloadValue(row.output ?? row.outputText),
  error: payloadValue(row.error),
});

const projectRows = (
  rows: readonly JsonRecord[],
  spec: QuerySpec,
): readonly JsonRecord[] => rows.map((row) =>
  Object.fromEntries(spec.projection.fields.map((field) => [
    field,
    row[field] === undefined ? null : row[field],
  ])));

export const queryResponseFromResource = (
  input: unknown,
  expected: unknown,
): QueryResponse => {
  const spec = decodeQueryInput(expected);
  const envelope = requireRecord(input, "resource response must be an object");
  if (envelope.ok !== true) {
    throw new QueryProtocolError("resource response is not a success envelope", input);
  }
  const data = requireRecord(envelope.data, "resource response data must be an object");
  const offset = decodeCursor(spec);
  let rows: readonly JsonRecord[];
  let nextOffset: number | null = null;

  switch (spec.kind) {
    case "sessions":
    case "messages": {
      rows = requireRows(data.rows, `resource response for ${spec.kind} must contain data.rows`);
      nextOffset = resourcePage(data.page, spec, offset).nextOffset;
      break;
    }
    case "toolCalls": {
      const filters = spec.filters as Readonly<Record<string, unknown>> | undefined;
      if (typeof filters?.toolCallId === "string") {
        const row = requireRecord(data.row, "tool-call resource response must contain data.row");
        rows = offset === 0 ? [normalizeToolCall(row)] : [];
      } else {
        rows = requireRows(data.rows, "tool-calls resource response must contain data.rows")
          .map(normalizeToolCall);
        nextOffset = resourcePage(data.page, spec, offset).nextOffset;
      }
      break;
    }
    case "search": {
      rows = requireRows(data.matches, "search resource response must contain data.matches")
        .map(normalizeSearchMatch);
      nextOffset = resourcePage(data.page, spec, offset).nextOffset;
      break;
    }
  }

  const items = projectRows(rows, spec);
  return decodeQueryOutput({
    protocolVersion: spec.protocolVersion,
    kind: spec.kind,
    projection: spec.projection,
    page: {
      returned: items.length,
      ...(nextOffset === null ? {} : { nextCursor: encodeCursor(spec, nextOffset) }),
    },
    items,
  }, spec);
};

const resourceUrl = (
  serverUrl: string,
  request: QueryResourceRequest,
): URL => {
  const url = new URL(request.path, serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
  for (const [key, value] of Object.entries(request.params)) {
    url.searchParams.set(key, String(value));
  }
  return url;
};

const isTransientFetchError = (error: unknown): boolean => {
  const signals = [error];
  if (isRecord(error) && error.cause !== error) signals.push(error.cause);
  const description = signals
    .flatMap((value) => isRecord(value)
      ? [value.name, value.message, value.code]
      : [value])
    .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
    .join(" ");
  return /socket|closed|ECONNRESET|ETIMEDOUT|terminated|ConnectionRefused|TimeoutError|timed out|unable to connect/i.test(description);
};

export const fetchWithRetry = async (
  url: URL,
  options: FetchRequestOptions,
): Promise<Response> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch (error) {
      if (!isTransientFetchError(error) || attempt === 2) {
        throw new FetchTransportError(url, attempt + 1, error);
      }
      await Bun.sleep(250 * (attempt + 1));
    }
  }
  throw new FetchTransportError(url, 3, new Error("retry budget exhausted"));
};

export const runQuery = async (
  input: unknown,
  options: QueryRequestOptions,
): Promise<QueryResponse> => {
  const spec = decodeQueryInput(input);
  const request = queryResourceRequest(spec);
  const response = await fetchWithRetry(resourceUrl(options.serverUrl, request), options);
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new QueryProtocolError("resource response is not valid JSON", {
      path: request.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw new QueryTransportError(
      response.status,
      errorMessage(body, `${request.path} request failed with HTTP ${response.status}`),
      body,
    );
  }
  return queryResponseFromResource(body, spec);
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
