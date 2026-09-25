import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { NormalizedSession } from "../src/core/schemas";
import { configuredIgnoreRules, ignoreMatchFor, IngestIgnoreConfigError, parseIgnoreRules } from "../src/ingest-ignore";

const HOME = "/Users/tester";

type Fixture = {
  readonly rawPath?: string;
  readonly sourcePath?: string;
  readonly gitRemoteNormalized?: string;
  readonly projectIdentityKey?: string;
  readonly nativeProjectKey?: string;
  readonly text?: string;
  readonly model?: string;
  readonly modelProvider?: string;
};

const session = (fixture: Fixture = {}): NormalizedSession => ({
  nativeProjectKey: fixture.nativeProjectKey,
  projectIdentity: {
    projectIdentityKey: fixture.projectIdentityKey ?? "project-a",
    displayName: "project-a",
    confidence: "explicit",
    ...(fixture.rawPath === undefined ? {} : { rawPath: fixture.rawPath, normalizedPath: fixture.rawPath }),
    ...(fixture.gitRemoteNormalized === undefined ? {} : { gitRemoteNormalized: fixture.gitRemoteNormalized }),
    signals: [],
  },
  sourcePath: fixture.sourcePath ?? "/history/s.jsonl",
  events: [{ contentText: fixture.text ?? "hello" }],
  executionContexts: fixture.model === undefined && fixture.modelProvider === undefined
    ? []
    : [{ model: fixture.model, modelProvider: fixture.modelProvider }],
  usageRecords: [],
} as unknown as NormalizedSession);

const rules = (ignore: unknown) => parseIgnoreRules(ignore, HOME);
const match = (ignore: unknown, fixture: Fixture) => ignoreMatchFor(session(fixture), rules(ignore), HOME);

describe("ingest ignore rules: paths", () => {
  test("blocks the directory and everything under it, nothing beside it", () => {
    const ignore = { paths: ["~/Work/private"] };
    expect(match(ignore, { rawPath: "/Users/tester/Work/private" })).toEqual({ kind: "paths", entry: "~/Work/private" });
    expect(match(ignore, { rawPath: "/Users/tester/Work/private/sub/dir/" })).toBeDefined();
    expect(match(ignore, { rawPath: "/Users/tester/Work" })).toBeUndefined();
    expect(match(ignore, { rawPath: "/Users/tester/Work/other" })).toBeUndefined();
  });

  test("matches case-insensitively, through `..`, and on the source file path", () => {
    const ignore = { paths: ["/Users/tester/Work/Private/"] };
    expect(match(ignore, { rawPath: "/users/TESTER/work/private/x" })).toBeDefined();
    expect(match(ignore, { rawPath: "/Users/tester/Work/other/../Private" })).toBeDefined();
    expect(match(ignore, { sourcePath: "/Users/tester/Work/Private/.data/opencode.db" })).toBeDefined();
  });

  test("blocks a session started elsewhere that mentions the directory anywhere", () => {
    const ignore = { paths: ["~/Work/private"] };
    expect(match(ignore, { rawPath: "/Users/tester", text: "cat /Users/tester/Work/private/batch.csv" })).toBeDefined();
    expect(match(ignore, { rawPath: "/Users/tester", text: "open ~/work/PRIVATE/notes.md" })).toBeDefined();
    expect(match(ignore, { rawPath: "/Users/tester", text: "the private folder" })).toBeUndefined();
  });

  test("a symlinked rule also blocks its real directory", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "quasar-ignore-")));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const ignore = { paths: [join(base, "link")] };
    expect(match(ignore, { rawPath: join(base, "real", "src") })).toBeDefined();
    expect(match(ignore, { rawPath: join(base, "link", "src") })).toBeDefined();
  });
});

describe("ingest ignore rules: git remotes, project keys, models", () => {
  test("git remotes match the resolved remote and any mention of it", () => {
    const ignore = { gitRemotes: ["git@github.com:Acme/Private.git"] };
    expect(match(ignore, { gitRemoteNormalized: "github.com/acme/private" })).toEqual({ kind: "gitRemotes", entry: "git@github.com:Acme/Private.git" });
    expect(match(ignore, { text: "git clone https://github.com/acme/private" })).toBeDefined();
    expect(match(ignore, { gitRemoteNormalized: "github.com/acme/other" })).toBeUndefined();
  });

  test("project keys match the Quasar key or the provider-native key", () => {
    const ignore = { projectKeys: ["Secret-Key"] };
    expect(match(ignore, { projectIdentityKey: "secret-key" })).toEqual({ kind: "projectKeys", entry: "Secret-Key" });
    expect(match(ignore, { nativeProjectKey: "SECRET-KEY" })).toBeDefined();
    expect(match(ignore, { projectIdentityKey: "public" })).toBeUndefined();
  });

  test("models match provider/model globs, including provider-prefixed model ids", () => {
    expect(match({ models: ["acme/*"] }, { modelProvider: "Acme", model: "model-x-v2" })).toEqual({ kind: "models", entry: "acme/*" });
    expect(match({ models: ["*/model-x-*"] }, { modelProvider: "other", model: "model-x-v2" })).toBeDefined();
    expect(match({ models: ["model-x-v2"] }, { model: "model-x-v2" })).toBeDefined();
    expect(match({ models: ["acme/model-x-v2"] }, { model: "acme/model-x-v2" })).toBeDefined();
    expect(match({ models: ["acme/*"] }, { modelProvider: "anthropic", model: "claude-opus-5-5" })).toBeUndefined();
    expect(match({ models: ["acme/*"] }, { text: "we compared acme/model-x-v2" })).toBeUndefined();
  });
});

describe("ingest ignore config", () => {
  test("rejects anything malformed instead of ingesting", () => {
    expect(() => rules(["~/Work"])).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ path: ["~/Work"] })).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ paths: "~/Work" })).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ paths: ["Work/private"] })).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ paths: ["/"] })).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ projectKeys: [""] })).toThrow(IngestIgnoreConfigError);
    expect(() => rules({ gitRemotes: [42] })).toThrow(IngestIgnoreConfigError);
  });

  test("loads from QUASAR_CONFIG and fails closed on an unreadable or misspelled config", () => {
    const dir = mkdtempSync(join(tmpdir(), "quasar-ignore-config-"));
    const write = (name: string, content: string) => {
      const path = join(dir, name);
      writeFileSync(path, content);
      return path;
    };
    const good = write("good.json", JSON.stringify({ serverUrl: "http://x:6180", ignore: { paths: ["/secret/project"] } }));
    expect(configuredIgnoreRules({ QUASAR_CONFIG: good, HOME }).paths[0]?.prefixes).toEqual(["/secret/project"]);
    expect(() => configuredIgnoreRules({ QUASAR_CONFIG: write("broken.json", "{ nope"), HOME })).toThrow(IngestIgnoreConfigError);
    expect(() => configuredIgnoreRules({ QUASAR_CONFIG: write("typo.json", JSON.stringify({ ignored: { paths: ["/x"] } })), HOME }))
      .toThrow(IngestIgnoreConfigError);
    expect(configuredIgnoreRules({ QUASAR_CONFIG: join(dir, "missing.json"), HOME }).paths).toEqual([]);
  });
});
