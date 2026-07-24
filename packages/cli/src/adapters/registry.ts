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
import { opencodeAdapter } from "./opencode";

/**
 * Stable adapters included in `ingest --provider all`. Amp is intentionally
 * excluded until dogfooded — reachable only via `--provider amp`.
 */
export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  hermesAdapter,
  kimiAdapter,
  antigravityAdapter,
  ompAdapter,
  piAdapter,
  cursorAdapter,
  devinAdapter,
] as const;

const gatedAdapters = [ampAdapter] as const;

export const adaptersByProvider = new Map(
  [...stableAdapters, ...gatedAdapters].map((adapter) => [adapter.provider, adapter]),
);
