import { readFileSync } from "node:fs";

import {
  SessionEnrichment,
  SessionEnrichmentPage,
  decodeSessionEnrichmentFiltersSync,
  decodeSessionEnrichmentSync,
  type SessionEnrichmentFilters,
  type SessionEnrichmentPage as SessionEnrichmentPageValue,
} from "@skastr0/quasar-protocol";
import { Schema } from "effect";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const WriteResponse = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("session-enrichment-write"),
  data: Schema.Struct({
    row: SessionEnrichment,
  }),
});

const ListResponse = Schema.Struct({
  ok: Schema.Literal(true),
  command: Schema.Literal("session-enrichments"),
  data: SessionEnrichmentPage,
});

const decodeWriteResponse = Schema.decodeUnknownSync(
  WriteResponse,
  strictParseOptions,
);
const decodeListResponse = Schema.decodeUnknownSync(
  ListResponse,
  strictParseOptions,
);

export class SessionEnrichmentInputError extends
  Schema.TaggedError<SessionEnrichmentInputError>()(
    "SessionEnrichmentInputError",
    {
      message: Schema.String,
      details: Schema.optional(Schema.Unknown),
    },
  )
{}

export class SessionEnrichmentTransportError extends
  Schema.TaggedError<SessionEnrichmentTransportError>()(
    "SessionEnrichmentTransportError",
    {
      message: Schema.String,
      status: Schema.Number,
      details: Schema.optional(Schema.Unknown),
    },
  )
{}

export class SessionEnrichmentProtocolError extends
  Schema.TaggedError<SessionEnrichmentProtocolError>()(
    "SessionEnrichmentProtocolError",
    {
      message: Schema.String,
      details: Schema.optional(Schema.Unknown),
    },
  )
{}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const errorMessage = (body: unknown, fallback: string): string => {
  if (
    isRecord(body)
    && isRecord(body.error)
    && typeof body.error.message === "string"
  ) {
    return body.error.message;
  }
  return fallback;
};

export const readSessionEnrichmentArgument = (
  source: string | undefined,
): SessionEnrichment => {
  if (source === undefined || source.trim() === "") {
    throw new SessionEnrichmentInputError({
      message:
        "enrichment-write requires <inline-json|@file|->",
      details: {
        expected: "inline JSON, @file, or - for stdin",
        received: source ?? null,
      },
    });
  }
  let raw: string;
  try {
    raw = source === "-"
      ? readFileSync(0, "utf8")
      : source.startsWith("@")
        ? readFileSync(source.slice(1), "utf8")
        : source;
  } catch (error) {
    throw new SessionEnrichmentInputError({
      message: "failed to read session enrichment input",
      details: {
        source,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  let input: unknown;
  try {
    input = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new SessionEnrichmentInputError({
      message: "session enrichment input is not valid JSON",
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  try {
    return decodeSessionEnrichmentSync(input);
  } catch (error) {
    throw new SessionEnrichmentInputError({
      message:
        "session enrichment input failed quasar.session-enrichment/v1 strict decode",
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

export interface SessionEnrichmentClientOptions {
  readonly serverUrl: string;
  readonly timeoutMs: number;
  readonly fetchImpl?: typeof fetch;
}

export interface WriteSessionEnrichmentOptions
  extends SessionEnrichmentClientOptions {
  readonly ingestToken: string;
}

const requestJson = async (
  url: URL,
  init: Omit<RequestInit, "signal">,
  options: SessionEnrichmentClientOptions,
): Promise<unknown> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    throw new SessionEnrichmentTransportError({
      message: `session enrichment request failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      status: 0,
      details: { url: url.toString() },
    });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new SessionEnrichmentProtocolError({
      message: "session enrichment response is not valid JSON",
      details: {
        status: response.status,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  if (!response.ok) {
    throw new SessionEnrichmentTransportError({
      message: errorMessage(
        body,
        `session enrichment request failed with HTTP ${response.status}`,
      ),
      status: response.status,
      details: body,
    });
  }
  return body;
};

export const writeSessionEnrichment = async (
  enrichment: SessionEnrichment,
  options: WriteSessionEnrichmentOptions,
): Promise<SessionEnrichment> => {
  const url = new URL(
    "/session-enrichments",
    options.serverUrl.endsWith("/")
      ? options.serverUrl
      : `${options.serverUrl}/`,
  );
  const body = await requestJson(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-quasar-ingest-token": options.ingestToken,
      },
      body: JSON.stringify(enrichment),
    },
    options,
  );
  try {
    return decodeWriteResponse(body).data.row;
  } catch (error) {
    throw new SessionEnrichmentProtocolError({
      message:
        "session enrichment write response failed strict decode",
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
};

export interface ListSessionEnrichmentsOptions
  extends SessionEnrichmentClientOptions {
  readonly filters: {
    readonly projectKey?: string;
    readonly sessionId?: string;
    readonly namespace?: string;
    readonly producer?: string;
    readonly inputHash?: string;
  };
  readonly limit: number;
  readonly cursor?: string;
}

export const listSessionEnrichments = async (
  options: ListSessionEnrichmentsOptions,
): Promise<SessionEnrichmentPageValue> => {
  let filters: SessionEnrichmentFilters;
  try {
    filters = decodeSessionEnrichmentFiltersSync(options.filters);
  } catch (error) {
    throw new SessionEnrichmentInputError({
      message: "session enrichment filters failed strict decode",
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
  const url = new URL(
    "/session-enrichments",
    options.serverUrl.endsWith("/")
      ? options.serverUrl
      : `${options.serverUrl}/`,
  );
  for (const [name, value] of Object.entries({
    projectKey: filters.projectKey,
    sessionId: filters.sessionId,
    namespace: filters.namespace,
    producer: filters.producer,
    inputHash: filters.inputHash,
    limit: options.limit,
    cursor: options.cursor,
  })) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  const body = await requestJson(
    url,
    { method: "GET" },
    options,
  );
  try {
    return decodeListResponse(body).data;
  } catch (error) {
    throw new SessionEnrichmentProtocolError({
      message:
        "session enrichment list response failed strict decode",
      details: {
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }
};
