import { existsSync, readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join, resolve } from "node:path";

export interface QuasarClientConfig {
  readonly convexUrl?: string;
  readonly url?: string;
  readonly fallbackUrls?: {
    readonly convexUrl?: string;
    readonly url?: string;
  };
}

export interface QuasarLocalConvexConfig {
  readonly actionSecret?: string;
}

export const quasarHome = () =>
  resolve(process.env.QUASAR_HOME ?? join(homedir(), ".config", "quasar"));

export const configPath = () =>
  resolve(process.env.QUASAR_CONFIG ?? join(quasarHome(), "config.json"));

const machinePath = () => join(quasarHome(), "machine.json");
const localConvexConfigPath = () =>
  resolve(
    process.env.QUASAR_LOCAL_CONVEX_CONFIG ??
      join(quasarHome(), "local", "default", "config.json"),
  );

const readJson = (path: string): unknown | undefined => {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const asConfig = (value: unknown): QuasarClientConfig | undefined => {
  if (!isRecord(value)) return undefined;
  const fallback = isRecord(value.fallbackUrls) ? value.fallbackUrls : undefined;
  return {
    convexUrl: asString(value.convexUrl),
    url: asString(value.url),
    ...(fallback !== undefined
      ? {
          fallbackUrls: {
            convexUrl: asString(fallback.convexUrl),
            url: asString(fallback.url),
          },
        }
      : {}),
  };
};

const asLocalConvexConfig = (value: unknown): QuasarLocalConvexConfig | undefined => {
  if (!isRecord(value)) return undefined;
  return { actionSecret: asString(value.actionSecret) };
};

const machineHostname = (): string | undefined => {
  const parsed = readJson(machinePath());
  if (!isRecord(parsed)) return undefined;
  return asString(parsed.hostname);
};

const prefersFallbackUrl = (): boolean => {
  const override = process.env.QUASAR_USE_FALLBACK_URL;
  if (override === "1" || override === "true") return true;
  if (override === "0" || override === "false") return false;
  const name = machineHostname() ?? hostname();
  return name === "macmini.local" || name === "mac-mini" || name.startsWith("mac-mini.");
};

export const loadQuasarClientConfig = (): QuasarClientConfig | undefined =>
  asConfig(readJson(configPath()));

export const configuredActionSecret = (): string | undefined => {
  const explicit = process.env.QUASAR_ACTION_SECRET;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();
  return asLocalConvexConfig(readJson(localConvexConfigPath()))?.actionSecret;
};

export const configuredConvexUrl = (): string | undefined => {
  const explicit = process.env.CONVEX_SELF_HOSTED_URL ?? process.env.CONVEX_URL;
  if (explicit !== undefined && explicit.trim().length > 0) return explicit.trim();

  const config = loadQuasarClientConfig();
  if (config === undefined) return undefined;
  if (prefersFallbackUrl()) {
    return config.fallbackUrls?.convexUrl ?? config.fallbackUrls?.url ?? config.convexUrl ?? config.url;
  }
  return config.convexUrl ?? config.url ?? config.fallbackUrls?.convexUrl ?? config.fallbackUrls?.url;
};
