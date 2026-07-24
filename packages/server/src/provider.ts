import { Schema } from "effect";

export const Provider = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "kimi",
  "hermes",
  "antigravity",
  "omp",
  "pi",
  "cursor",
  "devin",
  "amp",
);
export type Provider = typeof Provider.Type;
