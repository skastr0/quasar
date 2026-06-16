import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { hermesAdapter } from "./hermes";
import { kimiAdapter } from "./kimi";
import { opencodeAdapter } from "./opencode";
import type { AdapterDiscoverOptions, AdapterReadResult, SessionAdapter } from "./types";

export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  hermesAdapter,
  kimiAdapter,
  antigravityAdapter,
] as const;

export const experimentalAdapters = [] as const;

export const allAdapters: readonly SessionAdapter[] = [
  ...stableAdapters,
  ...experimentalAdapters,
];

export const adaptersByProvider = new Map(
  allAdapters.map((adapter) => [adapter.provider, adapter]),
);

export const readAdapters = async (
  adapters: readonly SessionAdapter[],
  options: AdapterDiscoverOptions,
): Promise<AdapterReadResult> => {
  const results = await Promise.all(adapters.map((adapter) => adapter.read(options)));
  return {
    sourceRoots: results.flatMap((result) => result.sourceRoots),
    sessions: results.flatMap((result) => result.sessions),
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
};
