import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface QuasarClientConfig {
  readonly localServerUrl?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asClientConfig = (value: unknown): QuasarClientConfig => {
  if (!isRecord(value)) return {};
  return {
    localServerUrl: asString(value.localServerUrl),
  };
};

export const defaultClientConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  resolve(env.QUASAR_CONFIG ?? join(homedir(), ".config", "quasar", "config.json"));

export const loadClientConfig = (path = defaultClientConfigPath()): QuasarClientConfig | undefined => {
  if (!existsSync(path)) return undefined;
  return asClientConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
};

export const configuredServerUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const explicit = asString(env.QUASAR_LOCAL_SERVER_URL);
  if (explicit !== undefined) return explicit;

  const config = loadClientConfig(defaultClientConfigPath(env));
  if (config === undefined) return undefined;
  return config.localServerUrl;
};
