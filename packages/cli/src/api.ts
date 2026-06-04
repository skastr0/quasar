import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
} from "@effect/platform";
import { Effect, Layer, Schema } from "effect";

import { loadAppConfig, requireApiKey } from "./config";
import { USER_AGENT } from "./constants";
import { ApiDecodeError, ApiRequestError, ApiResponseError } from "./errors";
import { decodeJsonText } from "./json";

type Method = "GET" | "POST";

interface RequestSpec<A, I, R> {
  readonly method: Method;
  readonly path: string;
  readonly query?: Record<string, string | undefined>;
  readonly body?: unknown;
  readonly responseSchema: Schema.Schema<A, I, R>;
}

const compactQuery = (query: Record<string, string | undefined> | undefined) =>
  query === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(query).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );

const baseClient = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const config = yield* loadAppConfig();
  const apiKey = yield* requireApiKey();
  return client.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(config.apiBaseUrl),
        HttpClientRequest.acceptJson,
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.setHeader("user-agent", USER_AGENT),
      ),
    ),
  );
});

const requestFor = (spec: Omit<RequestSpec<unknown, unknown, never>, "responseSchema">) => {
  if (spec.method === "GET") {
    return HttpClientRequest.get(spec.path, {
      urlParams: compactQuery(spec.query),
    });
  }
  const request = HttpClientRequest.post(spec.path, {
    urlParams: compactQuery(spec.query),
  });
  return spec.body === undefined
    ? request
    : request.pipe(HttpClientRequest.bodyUnsafeJson(spec.body));
};

const parseMaybeJson = (text: string) =>
  text.trim().length === 0
    ? Effect.succeed<unknown | undefined>(undefined)
    : decodeJsonText(Schema.Unknown, text, "api-response").pipe(
        Effect.catchAll(() => Effect.succeed<unknown>(text)),
      );

const apiMessage = (status: number, body: unknown) => {
  if (typeof body === "string" && body.trim().length > 0) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (
      record.error &&
      typeof record.error === "object" &&
      typeof (record.error as Record<string, unknown>).message === "string"
    ) {
      return String((record.error as Record<string, unknown>).message);
    }
    if (typeof record.message === "string") return record.message;
  }
  return `API request failed with status ${status}`;
};

export const requestJson = <A, I, R>(spec: RequestSpec<A, I, R>) =>
  Effect.gen(function* () {
    const client = yield* baseClient;
    const response = yield* client.execute(requestFor(spec)).pipe(
      Effect.mapError(
        (error) =>
          new ApiRequestError({
            method: spec.method,
            path: spec.path,
            reason: error._tag === "RequestError" ? error.reason : error._tag,
            message: error.message,
          }),
      ),
    );
    const text = yield* response.text.pipe(
      Effect.mapError(
        (error) =>
          new ApiRequestError({
            method: spec.method,
            path: spec.path,
            reason: error.reason,
            message: error.message,
          }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      const body = yield* parseMaybeJson(text);
      return yield* new ApiResponseError({
        method: spec.method,
        path: spec.path,
        status: response.status,
        message: apiMessage(response.status, body),
        body,
      });
    }
    if (text.trim().length === 0) {
      return yield* new ApiDecodeError({
        method: spec.method,
        path: spec.path,
        message: "API returned an empty response body",
      });
    }
    return yield* Schema.decodeUnknown(Schema.parseJson(spec.responseSchema))(text).pipe(
      Effect.mapError(
        (error) =>
          new ApiDecodeError({
            method: spec.method,
            path: spec.path,
            message: error.message,
          }),
      ),
    );
  });

export const AppLayer = Layer.mergeAll(FetchHttpClient.layer);
