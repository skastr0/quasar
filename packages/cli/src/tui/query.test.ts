import { expect, test } from "bun:test";

import { filterSummary, parseQuery, shortProject } from "./query";

test("parseQuery returns free text when no filters", () => {
  expect(parseQuery("effect timeout retry")).toEqual({ text: "effect timeout retry" });
});

test("parseQuery extracts key:value filters and lowercases provider/role", () => {
  expect(parseQuery("project:prism provider:Grok role:User effect timeout")).toEqual({
    text: "effect timeout",
    projectKey: "prism",
    provider: "grok",
    role: "user",
  });
});

test("parseQuery supports @project and #provider shorthand", () => {
  expect(parseQuery("@quasar #kimi vector index")).toEqual({
    text: "vector index",
    projectKey: "quasar",
    provider: "kimi",
  });
});

test("parseQuery leaves an invalid role token in the text", () => {
  const out = parseQuery("role:bogus hello");
  expect(out.role).toBeUndefined();
  expect(out.text).toBe("role:bogus hello");
});

test("parseQuery accepts every stored message role used by query resources", () => {
  expect(parseQuery("role:user vector")).toMatchObject({ role: "user", text: "vector" });
  expect(parseQuery("role:assistant plan")).toMatchObject({ role: "assistant", text: "plan" });
  expect(parseQuery("role:reasoning vector")).toMatchObject({ role: "reasoning", text: "vector" });
  expect(parseQuery("role:thinking plan")).toEqual({ text: "role:thinking plan" });
});

test("filterSummary and shortProject render compactly", () => {
  expect(shortProject("git:github.com/skastr0/quasar")).toBe("quasar");
  expect(filterSummary(parseQuery("project:git:github.com/skastr0/quasar #grok role:user x"))).toBe(
    "project:quasar #grok role:user",
  );
});
