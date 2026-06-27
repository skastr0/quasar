/**
 * Query-language parsing. Filters live IN the query string (composable, no
 * picker chrome): `project:prism provider:grok role:user effect timeout`.
 * `@foo` is shorthand for project, `#foo` for provider. Everything else is the
 * free-text search. Pure and unit-tested.
 */
import type { SearchMode } from "./quasar-client";

export const SEARCH_ROLES = ["user", "assistant", "reasoning"] as const;
export type SearchRole = (typeof SEARCH_ROLES)[number];

export interface ParsedQuery {
  readonly text: string;
  readonly projectKey?: string;
  readonly provider?: string;
  readonly role?: SearchRole;
}

const isRole = (v: string): v is SearchRole => (SEARCH_ROLES as readonly string[]).includes(v);

export const parseQuery = (raw: string): ParsedQuery => {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  const text: string[] = [];
  let projectKey: string | undefined;
  let provider: string | undefined;
  let role: SearchRole | undefined;

  for (const token of tokens) {
    const colon = token.indexOf(":");
    const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    const value = colon > 0 ? token.slice(colon + 1) : "";

    if (key === "project" && value) projectKey = value;
    else if (key === "provider" && value) provider = value.toLowerCase();
    else if (key === "role" && value && isRole(value.toLowerCase())) role = value.toLowerCase() as SearchRole;
    else if (token.startsWith("@") && token.length > 1) projectKey = token.slice(1);
    else if (token.startsWith("#") && token.length > 1) provider = token.slice(1).toLowerCase();
    else text.push(token);
  }

  return { text: text.join(" "), projectKey, provider, role };
};

/** Short human-readable summary of the active filters, for the header chip. */
export const filterSummary = (q: ParsedQuery): string => {
  const parts: string[] = [];
  if (q.projectKey) parts.push(`project:${shortProject(q.projectKey)}`);
  if (q.provider) parts.push(`#${q.provider}`);
  if (q.role) parts.push(`role:${q.role}`);
  return parts.join(" ");
};

/** projectKey is often `git:github.com/owner/repo` — show just the tail. */
export const shortProject = (projectKey: string): string => {
  const slash = projectKey.lastIndexOf("/");
  return slash === -1 ? projectKey : projectKey.slice(slash + 1);
};

/** Whether two modes differ only because the index forced a fallback. */
export const fellBack = (requested: SearchMode, effective: SearchMode): boolean => requested !== effective;
