import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect } from "effect";

import {
  API_BASE_URL_ENV,
  API_KEY_ENV,
  API_KEY_HINT,
  DEFAULT_API_BASE_URL,
} from "./constants";
import { ConfigurationError, MissingApiKeyError } from "./errors";

export interface AppConfig {
  readonly apiBaseUrl: string;
  readonly apiKey?: string;
}

const configRoot = () =>
  process.env.QUASAR_HOME ??
  (process.env.HOME === undefined
    ? ".quasar"
    : join(process.env.HOME, ".config", "quasar"));

const normalizeBaseUrl = (raw: string) =>
  Effect.gen(function* () {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return yield* new ConfigurationError({
        field: API_BASE_URL_ENV,
        message: "Base URL cannot be empty",
      });
    }
    const url = yield* Effect.try({
      try: () => new URL(trimmed),
      catch: () =>
        new ConfigurationError({
          field: API_BASE_URL_ENV,
          message: "Invalid API base URL",
        }),
    });
    return url.toString().replace(/\/+$/, "");
  });

export const loadAppConfig = Effect.fn("loadAppConfig")(function* () {
  const rawFile = yield* Effect.tryPromise({
    try: () => readFile(join(configRoot(), "config.json"), "utf8"),
    catch: () => "{}",
  });
  const fileConfig = yield* Effect.try({
    try: () => JSON.parse(rawFile) as Record<string, unknown>,
    catch: () => ({}),
  });
  const apiBaseUrl = yield* normalizeBaseUrl(
    process.env[API_BASE_URL_ENV] ??
      (typeof fileConfig.url === "string" ? fileConfig.url : undefined) ??
      DEFAULT_API_BASE_URL,
  );
  const apiKey = (
    process.env[API_KEY_ENV] ??
    (typeof fileConfig.token === "string" ? fileConfig.token : undefined)
  )?.trim();
  return {
    apiBaseUrl,
    ...(apiKey !== undefined && apiKey.length > 0 ? { apiKey } : {}),
  } satisfies AppConfig;
});

export const requireApiKey = Effect.fn("requireApiKey")(function* () {
  const config = yield* loadAppConfig();
  if (!config.apiKey) {
    return yield* new MissingApiKeyError({
      envVar: API_KEY_ENV,
      hint: API_KEY_HINT,
    });
  }
  return config.apiKey;
});
