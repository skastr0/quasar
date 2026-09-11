import { ampAdapter } from "./amp";
import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { devinAdapter } from "./devin";
import { grokAdapter } from "./grok";
import { hermesAdapter } from "./hermes";
import { kimiAdapter } from "./kimi";
import { ompAdapter } from "./omp";
import { piAdapter } from "./pi";
import { primeAdapter } from "./prime";
import { opencodeAdapter } from "./opencode";

/**
 * Adapters that read local files. Included in `ingest --provider all`, except
 * Grok when `QUASAR_GROK_INGEST` is off.
 */
export const localAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  hermesAdapter,
  kimiAdapter,
  antigravityAdapter,
  ompAdapter,
  piAdapter,
  primeAdapter,
  cursorAdapter,
  devinAdapter,
] as const;

/**
 * Adapters that call a remote service on every run. Excluded from
 * `ingest --provider all` unless explicitly enabled, so a machine never polls a
 * provider's servers by accident. `quasar daemon install --amp` enables Amp.
 */
export const remoteAdapters = [ampAdapter] as const;

/** Every stable adapter, local and remote. */
export const stableAdapters = [...localAdapters, ...remoteAdapters] as const;

/** Environment switch the daemon installer writes when Amp ingest is enabled. */
export const AMP_INGEST_ENV = "QUASAR_AMP_INGEST";

/**
 * Temporary hold for Grok on `ingest --provider all`. Explicit `ingest
 * --provider grok` is unchanged. Default remains on so existing clients keep
 * Grok in `all` unless the daemon (or an operator) writes `off`.
 */
export const GROK_INGEST_ENV = "QUASAR_GROK_INGEST";

export const ampIngestEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env[AMP_INGEST_ENV]?.trim().toLowerCase();
  return value === "on" || value === "1" || value === "true";
};

export const grokIngestEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const value = env[GROK_INGEST_ENV]?.trim().toLowerCase();
  return value !== "off" && value !== "0" && value !== "false";
};

/** Providers `ingest --provider all` runs on this machine. */
export const defaultIngestProviders = (env: NodeJS.ProcessEnv = process.env) => [
  ...localAdapters
    .map((adapter) => adapter.provider)
    .filter((provider) => provider !== "grok" || grokIngestEnabled(env)),
  ...(ampIngestEnabled(env) ? remoteAdapters.map((adapter) => adapter.provider) : []),
];

export const adaptersByProvider = new Map(
  stableAdapters.map((adapter) => [adapter.provider, adapter]),
);
