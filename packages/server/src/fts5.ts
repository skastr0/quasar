import { createHash } from "node:crypto";

export const fts5QueryForText = (query: string): string | undefined => {
  const tokens = query.match(/[\p{L}\p{N}]+/gu)?.map((token) => token.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" AND ");
};

export const positiveInt = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && value !== undefined && value > 0 ? value : fallback;

/**
 * Scope token for a project key. Ported byte-for-byte from
 * sqliteFirstProof.ts (ftsProjectScopeToken) so the proof path and the
 * serving path produce identical tokens for the same projectKey.
 */
export const ftsProjectScopeToken = (projectKey: string): string =>
  `p${createHash("sha1").update(projectKey).digest("hex")}`;

/**
 * Scope token for a message role. Ported byte-for-byte from
 * sqliteFirstProof.ts (ftsRoleScopeToken).
 */
export const ftsRoleScopeToken = (role: string): string =>
  `r${role.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

/** Scope token for a provider name, following the same shape as ftsRoleScopeToken. */
export const ftsProviderScopeToken = (provider: string): string =>
  `v${provider.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

/** Provider derived from a sessionId of the form `<provider>:<rest>` (prefix before the first colon). */
export const providerFromSessionId = (sessionId: string): string => {
  const colon = sessionId.indexOf(":");
  return colon === -1 ? sessionId : sessionId.slice(0, colon);
};

export interface ScopedFtsQueryInput {
  readonly query: string;
  readonly projectKey?: string;
  readonly role?: string;
  readonly provider?: string;
}

/**
 * Compose a scoped FTS5 MATCH query: bare, unquoted scope tokens (project,
 * role, provider — in that order, matching the indexed text's token prefix
 * order) AND-joined ahead of the quoted user-query tokens from
 * fts5QueryForText. Returns undefined when the user query itself has no
 * indexable letter/number tokens, mirroring fts5QueryForText's no-result
 * semantics.
 */
export const composeScopedFtsQuery = (input: ScopedFtsQueryInput): string | undefined => {
  const textQuery = fts5QueryForText(input.query);
  if (textQuery === undefined) return undefined;
  const scopedTerms = [
    input.projectKey === undefined ? undefined : ftsProjectScopeToken(input.projectKey),
    input.role === undefined ? undefined : ftsRoleScopeToken(input.role),
    input.provider === undefined ? undefined : ftsProviderScopeToken(input.provider),
    textQuery,
  ].filter((term): term is string => term !== undefined);
  return scopedTerms.join(" AND ");
};
