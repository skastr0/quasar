import { createHash } from "node:crypto";

import {
  decodeSessionEnrichmentPageSync,
  type SessionEnrichmentFilters,
  type SessionEnrichmentPage,
} from "@skastr0/quasar-protocol";
import { Effect, Schema } from "effect";

import {
  LocalStore,
  type SessionEnrichmentScanKey,
} from "./store";

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const CursorPayload = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("session-enrichments"),
  fingerprint: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(128),
  ),
  after: Schema.Struct({
    sessionId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512)),
    namespace: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(128)),
  }),
}).annotations({
  identifier: "QuasarSessionEnrichmentCursorV1",
  parseOptions: strictParseOptions,
});

const decodeCursorPayload = Schema.decodeUnknownSync(
  CursorPayload,
  strictParseOptions,
);

export class SessionEnrichmentCursorError extends
  Schema.TaggedError<SessionEnrichmentCursorError>()(
    "SessionEnrichmentCursorError",
    {
      message: Schema.String,
    },
  )
{}

const filterFingerprint = (filters: SessionEnrichmentFilters): string =>
  createHash("sha256")
    .update(JSON.stringify({
      projectKey: filters.projectKey ?? null,
      sessionId: filters.sessionId ?? null,
      namespace: filters.namespace ?? null,
      producer: filters.producer ?? null,
      inputHash: filters.inputHash ?? null,
    }))
    .digest("base64url");

const encodeCursor = (
  filters: SessionEnrichmentFilters,
  after: SessionEnrichmentScanKey,
): string =>
  Buffer.from(JSON.stringify({
    version: 1,
    kind: "session-enrichments",
    fingerprint: filterFingerprint(filters),
    after,
  }), "utf8").toString("base64url");

const decodeCursor = (
  filters: SessionEnrichmentFilters,
  cursor: string,
): SessionEnrichmentScanKey => {
  if (cursor.length > 4_096) {
    throw new SessionEnrichmentCursorError({
      message: "session enrichment cursor exceeds 4096 characters",
    });
  }
  let input: unknown;
  try {
    input = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new SessionEnrichmentCursorError({
      message: "session enrichment cursor is malformed",
    });
  }
  let payload: typeof CursorPayload.Type;
  try {
    payload = decodeCursorPayload(input);
  } catch {
    throw new SessionEnrichmentCursorError({
      message: "session enrichment cursor is malformed",
    });
  }
  if (payload.fingerprint !== filterFingerprint(filters)) {
    throw new SessionEnrichmentCursorError({
      message:
        "session enrichment cursor does not match the requested filters",
    });
  }
  return payload.after;
};

export interface SessionEnrichmentPageRequest {
  readonly filters: SessionEnrichmentFilters;
  readonly limit: number;
  readonly cursor?: string;
}

export const executeSessionEnrichmentQuery = (
  request: SessionEnrichmentPageRequest,
) =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const after = request.cursor === undefined
      ? undefined
      : yield* Effect.try({
          try: () => decodeCursor(request.filters, request.cursor!),
          catch: (error) =>
            error instanceof SessionEnrichmentCursorError
              ? error
              : new SessionEnrichmentCursorError({
                  message: "session enrichment cursor is malformed",
                }),
        });
    const found = yield* store.querySessionEnrichments({
      ...request.filters,
      ...(after === undefined ? {} : { after }),
      limit: request.limit + 1,
    });
    const rows = found.slice(0, request.limit);
    const last = rows.at(-1);
    const nextCursor = found.length > request.limit && last !== undefined
      ? encodeCursor(request.filters, {
          sessionId: last.sessionId,
          namespace: last.namespace,
        })
      : undefined;
    return decodeSessionEnrichmentPageSync({
      rows,
      page: {
        returned: rows.length,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      },
    }) satisfies SessionEnrichmentPage;
  });
