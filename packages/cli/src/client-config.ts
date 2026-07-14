// Server-URL/ingest-token resolution is no longer CLI-private: the file read
// + precedence (env > config file > default path) is single-sourced from
// @skastr0/quasar-sdk's QuasarConfig plumbing, which the SDK-backed read
// commands resolve through too (see cli.ts sdkConfigFor). This file keeps
// only the CLI's own narrower, exact-shape surface ({serverUrl, ingestToken},
// no httpTimeoutMs) that daemon/ingest callers and client-config.test.ts pin.
import {
  defaultClientConfigPath as sdkDefaultClientConfigPath,
  loadClientConfig as sdkLoadClientConfig,
} from "@skastr0/quasar-sdk";

export interface QuasarClientConfig {
  readonly serverUrl?: string;
  readonly ingestToken?: string;
}

const asString = (value: string | undefined): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const defaultClientConfigPath = (env: NodeJS.ProcessEnv = process.env): string =>
  sdkDefaultClientConfigPath(env);

export const loadClientConfig = (path = defaultClientConfigPath()): QuasarClientConfig | undefined => {
  const config = sdkLoadClientConfig(path);
  if (config === undefined) return undefined;
  return { serverUrl: config.serverUrl, ingestToken: config.ingestToken };
};

export const configuredServerUrl = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const explicit = asString(env.QUASAR_SERVER_URL);
  if (explicit !== undefined) return explicit;

  const config = loadClientConfig(defaultClientConfigPath(env));
  if (config === undefined) return undefined;
  return config.serverUrl;
};

export const configuredIngestToken = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const explicit = asString(env.QUASAR_INGEST_TOKEN);
  if (explicit !== undefined) return explicit;

  const config = loadClientConfig(defaultClientConfigPath(env));
  if (config === undefined) return undefined;
  return config.ingestToken;
};
