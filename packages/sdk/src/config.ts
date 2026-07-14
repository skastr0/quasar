import { Context, Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { QuasarConfigError } from "./errors.js";

export interface QuasarConfig {
  readonly serverUrl: string;
  readonly ingestToken?: string;
  readonly httpTimeoutMs: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asClientConfig = (
  value: unknown,
): { readonly serverUrl?: string; readonly ingestToken?: string; readonly httpTimeoutMs?: number } => {
  if (!isRecord(value)) return {};
  return {
    serverUrl: asString(value.serverUrl),
    ingestToken: asString(value.ingestToken),
    httpTimeoutMs: typeof value.httpTimeoutMs === "number" ? value.httpTimeoutMs : undefined,
  };
};

export const defaultClientConfigPath = (env: Record<string, string | undefined> = process.env): string =>
  resolve(env.QUASAR_CONFIG ?? join(homedir(), ".config", "quasar", "config.json"));

export const loadClientConfig = (path = defaultClientConfigPath()): {
  readonly serverUrl?: string;
  readonly ingestToken?: string;
  readonly httpTimeoutMs?: number;
} | undefined => {
  try {
    const content = readFileSync(path, "utf8");
    return asClientConfig(JSON.parse(content) as unknown);
  } catch {
    return undefined;
  }
};

export class QuasarConfigTag extends Context.Tag("@quasar/QuasarConfig")<
  QuasarConfigTag,
  QuasarConfig
>() {}

export const QuasarConfig = QuasarConfigTag;

/** Resolves QuasarConfig from env vars, config file, and defaults.
 * Resolution order: QUASAR_SERVER_URL env var > ~/.config/quasar/config.json serverUrl > error.
 * QUASAR_INGEST_TOKEN env var > config file ingestToken > undefined.
 * QUASAR_HTTP_TIMEOUT_MS env var > config file httpTimeoutMs > 60000ms default. */
export const QuasarConfigLive: Layer.Layer<QuasarConfigTag> = Layer.effect(
  QuasarConfigTag,
  Effect.sync(() => {
    const env = process.env;

    // Server URL is required
    const serverUrlFromEnv = asString(env.QUASAR_SERVER_URL);
    if (serverUrlFromEnv !== undefined) {
      const ingestToken = asString(env.QUASAR_INGEST_TOKEN);
      const timeoutMs =
        typeof env.QUASAR_HTTP_TIMEOUT_MS === "string"
          ? parseInt(env.QUASAR_HTTP_TIMEOUT_MS, 10) || 60_000
          : 60_000;
      return QuasarConfigTag.of({
        serverUrl: serverUrlFromEnv,
        ingestToken,
        httpTimeoutMs: timeoutMs,
      });
    }

    const config = loadClientConfig();
    if (config?.serverUrl !== undefined) {
      const ingestToken = asString(env.QUASAR_INGEST_TOKEN) ?? config.ingestToken;
      const timeoutMs =
        typeof env.QUASAR_HTTP_TIMEOUT_MS === "string"
          ? parseInt(env.QUASAR_HTTP_TIMEOUT_MS, 10) || (config.httpTimeoutMs ?? 60_000)
          : config.httpTimeoutMs ?? 60_000;
      return QuasarConfigTag.of({
        serverUrl: config.serverUrl,
        ingestToken,
        httpTimeoutMs: timeoutMs,
      });
    }

    throw new QuasarConfigError({
      message: "No serverUrl resolved from QUASAR_SERVER_URL env var or ~/.config/quasar/config.json",
    });
  }),
);

/** Manual config injection for tests or explicit URL pinning.
 * Usage: makeQuasarConfig({ serverUrl: "http://localhost:8080" }) */
export const makeQuasarConfig = (override: Partial<QuasarConfig>): Layer.Layer<QuasarConfigTag> =>
  Layer.effect(
    QuasarConfigTag,
    Effect.sync(() =>
      QuasarConfigTag.of({
        serverUrl: override.serverUrl ?? "",
        ingestToken: override.ingestToken,
        httpTimeoutMs: override.httpTimeoutMs ?? 60_000,
      }),
    ),
  );
