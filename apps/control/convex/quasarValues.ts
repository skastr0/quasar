import { v } from "convex/values";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const RRF_K = 60;

export const provider = v.union(
  v.literal("codex"),
  v.literal("claude"),
  v.literal("opencode"),
  v.literal("grok"),
  v.literal("amp"),
  v.literal("pi"),
  v.literal("kimi"),
  v.literal("droid"),
  v.literal("antigravity"),
  v.literal("cursor"),
  v.literal("gemini"),
  v.literal("unknown"),
);

export const role = v.union(
  v.literal("user"),
  v.literal("assistant"),
  v.literal("system"),
  v.literal("tool"),
  v.literal("thinking"),
  v.literal("unknown"),
);

export const eventKind = v.union(
  v.literal("message"),
  v.literal("tool_call"),
  v.literal("tool_result"),
  v.literal("reasoning"),
  v.literal("system"),
  v.literal("summary"),
  v.literal("edit"),
  v.literal("snapshot"),
  v.literal("lifecycle"),
  v.literal("unknown"),
);

export const searchArgs = {
  query: v.string(),
  projectIdentityKey: v.optional(v.string()),
  machineId: v.optional(v.string()),
  provider: v.optional(provider),
  agentName: v.optional(v.string()),
  role: v.optional(role),
  kind: v.optional(eventKind),
  toolName: v.optional(v.string()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  limit: v.optional(v.number()),
};

export const boundedLimit = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
};

export const dateMillis = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : undefined;
};

export const parseDateBound = (value: string | undefined, field: string) => {
  if (value === undefined) return undefined;
  const millis = dateMillis(value);
  if (millis === undefined) {
    throw new Error(`${field} must be a valid ISO date or timestamp.`);
  }
  return millis;
};

export const canonicalFilter = (key: string) => JSON.stringify(["project", key]);
export const machineFilter = (key: string) => JSON.stringify(["machine", key]);
export const providerFilter = (value: string) => JSON.stringify(["provider", value]);
export const kindFilter = (value: string) => JSON.stringify(["kind", value]);
