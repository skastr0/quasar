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

/** Stable adapters included in `ingest --provider all`. */
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
  primeAdapter,
  cursorAdapter,
  devinAdapter,
  ampAdapter,
] as const;

export const adaptersByProvider = new Map(
  stableAdapters.map((adapter) => [adapter.provider, adapter]),
);
