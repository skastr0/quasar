import { describe, expect, test } from "bun:test";

import {
  composeScopedFtsQuery,
  fts5QueryForText,
  ftsProjectScopeToken,
  ftsProviderScopeToken,
  ftsRoleScopeToken,
  providerFromSessionId,
} from "../src/fts5";

describe("fts5 scope tokens", () => {
  test("ftsProjectScopeToken is stable for a known input", () => {
    // Fixed sha1("git:github.com/skastr0/pulsar") — must stay byte-identical
    // to sqliteFirstProof.ts's ftsProjectScopeToken forever, since proof and
    // serving tokens must match.
    expect(ftsProjectScopeToken("git:github.com/skastr0/pulsar")).toBe(
      "p323d6e5dfb448a6414d15440c678396a5d494427",
    );
    // Deterministic: same input always yields the same token.
    expect(ftsProjectScopeToken("git:github.com/skastr0/pulsar")).toBe(
      ftsProjectScopeToken("git:github.com/skastr0/pulsar"),
    );
  });

  test("ftsProjectScopeToken handles hostile projectKeys without throwing", () => {
    expect(ftsProjectScopeToken("")).toBe("pda39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(ftsProjectScopeToken('project"with"quotes')).toBe("p988428f0acfcca239c8d539acbc19a413e0c8d33");
    expect(ftsProjectScopeToken("git:github.com/foo/bar")).toBe("p6f8bfe11fafdb018f005e433dcfbdb0934d8c593");
    expect(ftsProjectScopeToken("проект-α")).toBe("p1a40657ab1c588b9f74cfef4ebc5709c7f4e81ed");
    // Colons, slashes, quotes, and unicode all still produce a bare
    // alphanumeric token safe to embed unquoted in an FTS5 MATCH query.
    for (const key of ["", 'project"with"quotes', "git:github.com/foo/bar", "проект-α"]) {
      expect(ftsProjectScopeToken(key)).toMatch(/^p[0-9a-f]{40}$/);
    }
  });

  test("ftsRoleScopeToken covers the known role enum", () => {
    expect(ftsRoleScopeToken("user")).toBe("ruser");
    expect(ftsRoleScopeToken("assistant")).toBe("rassistant");
    expect(ftsRoleScopeToken("reasoning")).toBe("rreasoning");
  });

  test("ftsRoleScopeToken strips non-alphanumerics and lowercases", () => {
    expect(ftsRoleScopeToken("Assistant")).toBe("rassistant");
    expect(ftsRoleScopeToken("tool-call!")).toBe("rtoolcall");
    expect(ftsRoleScopeToken("")).toBe("r");
  });

  test("ftsProviderScopeToken strips non-alphanumerics and lowercases", () => {
    expect(ftsProviderScopeToken("codex")).toBe("vcodex");
    expect(ftsProviderScopeToken("Codex-CLI!")).toBe("vcodexcli");
    expect(ftsProviderScopeToken("")).toBe("v");
  });

  test("providerFromSessionId extracts the prefix before the first colon", () => {
    expect(providerFromSessionId("codex:abc123")).toBe("codex");
    expect(providerFromSessionId("opencode:some:nested:id")).toBe("opencode");
    expect(providerFromSessionId("session-a")).toBe("session-a");
    expect(providerFromSessionId("")).toBe("");
  });

  test("composeScopedFtsQuery matches the design receipt exactly", () => {
    expect(
      composeScopedFtsQuery({
        query: "pulsar forge",
        projectKey: "git:github.com/skastr0/pulsar",
        role: "assistant",
      }),
    ).toBe('p323d6e5dfb448a6414d15440c678396a5d494427 AND rassistant AND "pulsar" AND "forge"');
  });

  test("composeScopedFtsQuery inserts the provider token in project, role, provider, text order", () => {
    expect(
      composeScopedFtsQuery({
        query: "pulsar forge",
        projectKey: "git:github.com/skastr0/pulsar",
        role: "assistant",
        provider: "codex",
      }),
    ).toBe('p323d6e5dfb448a6414d15440c678396a5d494427 AND rassistant AND vcodex AND "pulsar" AND "forge"');
  });

  test("composeScopedFtsQuery omits absent scope filters", () => {
    expect(composeScopedFtsQuery({ query: "pulsar forge" })).toBe('"pulsar" AND "forge"');
    expect(composeScopedFtsQuery({ query: "pulsar forge", provider: "codex" })).toBe(
      'vcodex AND "pulsar" AND "forge"',
    );
  });

  test("composeScopedFtsQuery returns undefined when the query has no indexable tokens", () => {
    expect(
      composeScopedFtsQuery({
        query: " ::: ",
        projectKey: "git:github.com/skastr0/pulsar",
        role: "assistant",
        provider: "codex",
      }),
    ).toBeUndefined();
    expect(fts5QueryForText(" ::: ")).toBeUndefined();
  });

  test("composeScopedFtsQuery keeps scope tokens bare and unquoted", () => {
    const composed = composeScopedFtsQuery({
      query: "vector",
      projectKey: 'weird"key:with/slashes',
      role: "Tool-Call!",
      provider: "Codex-CLI!",
    })!;
    const [projectTerm, roleTerm, providerTerm, textTerm] = composed.split(" AND ");
    // Scope terms carry no quotes (safe to embed bare in MATCH); only the
    // trailing user-query term is quoted, per fts5QueryForText.
    expect([projectTerm, roleTerm, providerTerm]).toEqual([
      ftsProjectScopeToken('weird"key:with/slashes'),
      ftsRoleScopeToken("Tool-Call!"),
      ftsProviderScopeToken("Codex-CLI!"),
    ]);
    expect([projectTerm, roleTerm, providerTerm].join()).not.toContain('"');
    expect(textTerm).toBe('"vector"');
  });
});
