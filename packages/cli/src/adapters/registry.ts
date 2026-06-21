import { antigravityAdapter } from "./antigravity";
import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { hermesAdapter } from "./hermes";
import { kimiAdapter } from "./kimi";
import { opencodeAdapter } from "./opencode";

export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
  hermesAdapter,
  kimiAdapter,
  antigravityAdapter,
] as const;

export const adaptersByProvider = new Map(
  stableAdapters.map((adapter) => [adapter.provider, adapter]),
);
