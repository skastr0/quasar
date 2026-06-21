import { Schema } from "effect";

export const Provider = Schema.Literal(
  "codex",
  "claude",
  "opencode",
  "grok",
  "kimi",
  "hermes",
  "antigravity",
);
export type Provider = typeof Provider.Type;
