import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { Provider } from "../src/provider";

const srcRoot = join(import.meta.dir, "..", "src");

const tsFiles = (root: string): readonly string[] =>
  readdirSync(root, { recursive: true })
    .filter((entry): entry is string => typeof entry === "string" && entry.endsWith(".ts"))
    .map((entry) => join(root, entry));

const offenders = (predicate: (source: string) => boolean): readonly string[] =>
  tsFiles(srcRoot).filter((file) => predicate(readFileSync(file, "utf8")));

describe("server package boundary", () => {
  test("imports no CLI code and no provider parsers", () => {
    expect(offenders((src) => src.includes("@skastr0/quasar-cli") || src.includes("../cli/"))).toEqual([]);
    expect(offenders((src) => /from "\.\/adapters/.test(src) || /from "\.\.\/.*adapters/.test(src))).toEqual([]);
  });

  test("does no provider history-root discovery", () => {
    expect(offenders((src) => /QUASAR_(CODEX|CLAUDE|OPENCODE|GROK|HERMES|KIMI|ANTIGRAVITY|OMP|PI|CURSOR|DEVIN)_ROOT/.test(src))).toEqual([]);
  });

  test("exposes no provider-history command (server owns serve/worker/maintenance/search/status only)", () => {
    // The server never scans, discovers, or parses provider histories; ingest is
    // CLI-side only. Guard against an ingest/scan/discover command sneaking into
    // the server's only entrypoint surface.
    const mainSrc = readFileSync(join(srcRoot, "main.ts"), "utf8");
    expect(/\bscan\b|\bdiscover\b|provider.?histor/i.test(mainSrc)).toBe(false);
  });
});

describe("ingest boundary contract is locked", () => {
  test("provider enum is exactly the eleven supported providers", () => {
    expect([...Provider.literals]).toEqual([
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
    ]);
  });

  test("the message-role allowlist is exactly user/assistant/reasoning at the HTTP boundary", () => {
    // The HTTP ingest validator's role allowlist is the locked boundary; if a new
    // role is added it must be made explicit here AND in server.ts isMessageRow.
    const serverSrc = readFileSync(join(srcRoot, "server.ts"), "utf8");
    const match = serverSrc.match(/const roles = new Set<string>\(\[([^\]]*)\]\);/);
    expect(match).not.toBeNull();
    const literals = (match?.[1] ?? "")
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter((part) => part !== "");
    expect(literals).toEqual(["user", "assistant", "reasoning"]);
  });
});
