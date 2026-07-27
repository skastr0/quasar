import { Buffer } from "node:buffer";
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

interface OffsetQueryCursorPayload {
  readonly version: 1;
  readonly kind: Exclude<QuerySpec["kind"], "messages">;
  readonly fingerprint: string;
  readonly offset: number;
}

interface MessageQueryCursorPayload {
  readonly version: 2;
  readonly kind: "messages";
  readonly fingerprint: string;
  readonly snapshot: string;
  readonly after: {
    readonly sessionId: string;
    readonly sequence: number;
  };
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
    kind: spec.kind as OffsetQueryCursorPayload["kind"],
    fingerprint: queryFingerprint(spec),
    offset,
  } satisfies OffsetQueryCursorPayload), "utf8").toString("base64url");

const encodeMessageCursor = (
  spec: QuerySpec,
  snapshot: string,
  after: MessageQueryCursorPayload["after"],
): string =>
  Buffer.from(JSON.stringify({
    version: 2,
    kind: "messages",
    fingerprint: queryFingerprint(spec),
    snapshot,
    after,
  } satisfies MessageQueryCursorPayload), "utf8").toString("base64url");

const cursorPayload = (cursor: string): unknown => {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  } catch (error) {
    throw new QueryInputError("query cursor is malformed", {
      cursor,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
};

const decodeOffsetCursor = (spec: QuerySpec): number => {
  const cursor = spec.page.cursor;
  if (cursor === undefined) return 0;
  const payload = cursorPayload(cursor);
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

const decodeMessageCursor = (
  spec: QuerySpec,
): {
  readonly snapshot?: string;
  readonly after?: MessageQueryCursorPayload["after"];
} => {
  const cursor = spec.page.cursor;
  if (cursor === undefined) return {};
  const payload = cursorPayload(cursor);
  const after = isRecord(payload) && isRecord(payload.after)
    ? payload.after
    : undefined;
  if (
    !isRecord(payload)
    || payload.version !== 2
    || payload.kind !== "messages"
    || payload.fingerprint !== queryFingerprint(spec)
    || typeof payload.snapshot !== "string"
    || payload.snapshot.trim() === ""
    || after === undefined
    || typeof after.sessionId !== "string"
    || after.sessionId.trim() === ""
    || !Number.isSafeInteger(after.sequence)
    || (after.sequence as number) < 0
  ) {
    throw new QueryInputError("query cursor does not match the query shape", {
      expectedKind: spec.kind,
      cursor,
    });
  }
  return {
    snapshot: payload.snapshot,
    after: {
      sessionId: after.sessionId,
      sequence: after.sequence as number,
    },
  };
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
  messageAfter: typeof filters?.messageAfter === "string" ? filters.messageAfter : undefined,
  messageBefore: typeof filters?.messageBefore === "string" ? filters.messageBefore : undefined,
  sessionStartedAfter: typeof filters?.sessionStartedAfter === "string" ? filters.sessionStartedAfter : undefined,
  sessionStartedBefore: typeof filters?.sessionStartedBefore === "string" ? filters.sessionStartedBefore : undefined,
  rootsOnly: typeof filters?.rootsOnly === "boolean" ? String(filters.rootsOnly) : undefined,
  lineageRootSessionId: typeof filters?.lineageRootSessionId === "string"
    ? filters.lineageRootSessionId
    : undefined,
  toolName: typeof filters?.toolName === "string" ? filters.toolName : undefined,
});

const toolCallBodyFields = new Set(["input", "output", "error"]);

export const queryResourceRequest = (input: unknown): QueryResourceRequest => {
  const spec = decodeQueryInput(input);
  const filters = spec.filters as Readonly<Record<string, unknown>> | undefined;

  switch (spec.kind) {
    case "sessions": {
      const offset = decodeOffsetCursor(spec);
      return {
        path: "sessions",
        params: {
          ...resourceFilters(filters),
          limit: spec.page.limit,
          offset,
        },
      };
    }
    case "messages": {
      const cursor = decodeMessageCursor(spec);
      return {
        path: "messages",
        params: {
          ...resourceFilters(filters),
          limit: spec.page.limit,
          ...(cursor.after === undefined
            ? {}
            : {
              afterSessionId: cursor.after.sessionId,
              afterSequence: cursor.after.sequence,
            }),
          ...(cursor.snapshot === undefined
            ? {}
            : { snapshot: cursor.snapshot }),
        },
      };
    }
    case "search": {
      const offset = decodeOffsetCursor(spec);
      return {
        path: `search/${spec.mode}`,
        params: {
          ...resourceFilters(filters),
          limit: spec.page.limit,
          offset,
          q: spec.text,
        },
      };
    }
    case "toolCalls": {
      const offset = decodeOffsetCursor(spec);
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
      return {
        path: "tool-calls",
        params: {
          ...resourceFilters(filters),
          limit: spec.page.limit,
          offset,
        },
      };
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

interface MessagePage {
  readonly snapshot: string;
  readonly next: MessageQueryCursorPayload["after"] | null;
}

const messageKey = (
  value: JsonRecord,
): MessageQueryCursorPayload["after"] => {
  if (
    typeof value.sessionId !== "string"
    || value.sessionId.trim() === ""
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0
  ) {
    throw new QueryProtocolError(
      "message resource row must contain a sessionId and non-negative integer sequence",
      value,
    );
  }
  return {
    sessionId: value.sessionId,
    sequence: value.sequence as number,
  };
};

const compareMessageKeys = (
  left: MessageQueryCursorPayload["after"],
  right: MessageQueryCursorPayload["after"],
): number =>
  Buffer.compare(
    Buffer.from(left.sessionId, "utf8"),
    Buffer.from(right.sessionId, "utf8"),
  )
  || left.sequence - right.sequence;

const messageResourcePage = (
  value: unknown,
  rows: readonly JsonRecord[],
  spec: QuerySpec,
): MessagePage => {
  const page = requireRecord(value, "message resource response data.page must be an object");
  const cursor = decodeMessageCursor(spec);
  const next = page.next === null
    ? null
    : isRecord(page.next)
      ? messageKey(page.next)
      : undefined;
  if (
    page.limit !== spec.page.limit
    || typeof page.snapshot !== "string"
    || page.snapshot.trim() === ""
    || next === undefined
    || (
      cursor.snapshot !== undefined
      && page.snapshot !== cursor.snapshot
    )
  ) {
    throw new QueryProtocolError("message resource page does not match the request", {
      expected: {
        limit: spec.page.limit,
        ...(cursor.snapshot === undefined ? {} : { snapshot: cursor.snapshot }),
      },
      received: page,
    });
  }
  const keys = rows.map(messageKey);
  for (let index = 1; index < keys.length; index += 1) {
    if (compareMessageKeys(keys[index - 1]!, keys[index]!) >= 0) {
      throw new QueryProtocolError(
        "message resource rows are not in stable key order",
        rows,
      );
    }
  }
  if (
    cursor.after !== undefined
    && keys[0] !== undefined
    && compareMessageKeys(cursor.after, keys[0]) >= 0
  ) {
    throw new QueryProtocolError(
      "message resource page did not advance beyond its cursor",
      { cursor: cursor.after, first: keys[0] },
    );
  }
  const last = keys.at(-1);
  if (
    next !== null
    && (
      last === undefined
      || compareMessageKeys(next, last) !== 0
    )
  ) {
    throw new QueryProtocolError(
      "message resource next key does not match its last returned row",
      { next, last },
    );
  }
  return { snapshot: page.snapshot, next };
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
  let rows: readonly JsonRecord[];
  let nextCursor: string | undefined;

  switch (spec.kind) {
    case "sessions": {
      const offset = decodeOffsetCursor(spec);
      rows = requireRows(data.rows, "resource response for sessions must contain data.rows");
      const nextOffset = resourcePage(data.page, spec, offset).nextOffset;
      if (nextOffset !== null) nextCursor = encodeCursor(spec, nextOffset);
      break;
    }
    case "messages": {
      rows = requireRows(data.rows, "resource response for messages must contain data.rows");
      const page = messageResourcePage(data.page, rows, spec);
      if (page.next !== null) {
        nextCursor = encodeMessageCursor(spec, page.snapshot, page.next);
      }
      break;
    }
    case "toolCalls": {
      const offset = decodeOffsetCursor(spec);
      const filters = spec.filters as Readonly<Record<string, unknown>> | undefined;
      if (typeof filters?.toolCallId === "string") {
        const row = requireRecord(data.row, "tool-call resource response must contain data.row");
        rows = offset === 0 ? [normalizeToolCall(row)] : [];
      } else {
        rows = requireRows(data.rows, "tool-calls resource response must contain data.rows")
          .map(normalizeToolCall);
        const nextOffset = resourcePage(data.page, spec, offset).nextOffset;
        if (nextOffset !== null) nextCursor = encodeCursor(spec, nextOffset);
      }
      break;
    }
    case "search": {
      const offset = decodeOffsetCursor(spec);
      rows = requireRows(data.matches, "search resource response must contain data.matches")
        .map(normalizeSearchMatch);
      const nextOffset = resourcePage(data.page, spec, offset).nextOffset;
      if (nextOffset !== null) nextCursor = encodeCursor(spec, nextOffset);
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
      ...(nextCursor === undefined ? {} : { nextCursor }),
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
  const alias = ({
    "normalized-session": "normalizedSession",
    "mapped-session": "mappedSession",
    "letta-trajectory": "lettaTrajectory",
    "harbor-atif": "harborAtif",
    atif: "atifTrajectory",
    "atif-trajectory": "atifTrajectory",
    "session-enrichment": "sessionEnrichment",
  } as const)[name] ?? name;
  if (alias in protocolContracts) return alias as ProtocolContractName;
  return Object.entries(protocolContracts)
    .find(([, contract]) => contract.schemaId === name)?.[0] as ProtocolContractName | undefined;
};

export const protocolContract = (name?: string) => {
  if (name === undefined) return protocolDiscovery;
  const resolved = contractName(name);
  if (resolved === undefined) {
    throw new QueryInputError(`unknown schema ${name}`, {
      expected: [
        "normalized-session",
        "mapped-session",
        "trajectory",
        "letta-trajectory",
        "harbor-atif",
        "atif-trajectory",
        "query",
        "response",
        "session-enrichment",
      ],
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
