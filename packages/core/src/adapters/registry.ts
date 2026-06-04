import { ampAdapter } from "./amp";
import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { droidAdapter } from "./droid";
import { grokAdapter } from "./grok";
import { kimiAdapter } from "./kimi";
import { opencodeAdapter } from "./opencode";
import { piAdapter } from "./pi";
import type { AdapterDiscoverOptions, AdapterReadResult, SessionAdapter } from "./types";

export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  ampAdapter,
  piAdapter,
  kimiAdapter,
  droidAdapter,
  antigravityAdapter,
  cursorAdapter,
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
