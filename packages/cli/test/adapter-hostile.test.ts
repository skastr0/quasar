import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, test } from "bun:test";

import type { AdapterDiagnostic } from "../src/core/schemas";
import {
  adapterFor,
  appendText,
  buildFixtureFor,
  type AdapterFixture,
  type AdapterProvider,
} from "./adapter-test-harness";

const lineProviders = ["codex", "claude", "grok", "kimi", "antigravity"] as const;
const sqliteProviders = ["opencode", "hermes"] as const;
const allProviders = [...lineProviders, ...sqliteProviders] as const;
const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // best effort cleanup permission repair
    }
    rmSync(root, { recursive: true, force: true });
  }
});

const diagnosticBlob = (diagnostic: AdapterDiagnostic) =>
  `${diagnostic.message}\n${JSON.stringify(diagnostic.details ?? {})}`;

const expectNamedDiagnostic = (diagnostics: readonly AdapterDiagnostic[], name: string) => {
  expect(diagnostics.some((diagnostic) => diagnosticBlob(diagnostic).includes(name))).toBe(true);
};

const readProvider = async (provider: AdapterProvider, fixture: AdapterFixture) =>
  adapterFor(provider).read({
    machine: { machineId: "machine:test", hostname: "test-host", platform: "darwin" },
    now: "2026-06-11T00:00:00.000Z",
    roots: { [provider]: fixture.root },
    logicalRoots: { [provider]: fixture.logicalRoot },
  });

const withFixture = (provider: AdapterProvider) => {
  const root = mkdtempSync(join(tmpdir(), `quasar-${provider}-hostile-`));
  tempRoots.push(root);
  return buildFixtureFor(provider, root);
};

describe("adapter hostile file/line diagnostics", () => {
  for (const provider of lineProviders) {
    test(`${provider}: torn line emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      appendText(fixture.primaryPath, "{\"type\":");
      const result = await readProvider(provider, fixture);
      expectNamedDiagnostic(result.diagnostics, `${provider}.line.invalid_json`);
    }, 15_000);

    test(`${provider}: non-JSON line emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      appendText(fixture.primaryPath, "not json\n");
      const result = await readProvider(provider, fixture);
      expectNamedDiagnostic(result.diagnostics, `${provider}.line.invalid_json`);
    }, 15_000);

    test(`${provider}: empty primary file emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      writeFileSync(fixture.primaryPath, "", "utf8");
      const result = await readProvider(provider, fixture);
      const expected = provider === "codex" ? "codex.native_session_id.missing" : `${provider}.file.empty`;
      expect(result.sessions.length).toBeLessThanOrEqual(1);
      expect(result.diagnostics.some((diagnostic) => diagnosticBlob(diagnostic).includes(expected))).toBe(true);
    }, 15_000);

    test(`${provider}: unreadable primary file emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      chmodSync(fixture.primaryPath, 0);
      try {
        const result = await readProvider(provider, fixture);
        // Codex owns its first-record open path; line adapters use common.ts
        // which must name the kind as unreadable (never mask as invalid_json).
        const expected =
          provider === "codex" ? "codex.first_record.json.invalid" : `${provider}.line.unreadable`;
        expect(
          result.diagnostics.some((diagnostic) => diagnosticBlob(diagnostic).includes(expected)),
        ).toBe(true);
        if (provider !== "codex") {
          expect(
            result.diagnostics.some((diagnostic) =>
              diagnosticBlob(diagnostic).includes(`${provider}.line.invalid_json`),
            ),
          ).toBe(false);
        }
      } finally {
        chmodSync(fixture.primaryPath, 0o600);
      }
    }, 15_000);

    test(`${provider}: truncated tail emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      appendText(fixture.primaryPath, "\n{\"type\":\"user\"");
      const result = await readProvider(provider, fixture);
      expectNamedDiagnostic(result.diagnostics, `${provider}.line.invalid_json`);
    }, 15_000);

    test(`${provider}: unknown record type emits named diagnostic and does not pass through`, async () => {
      const fixture = withFixture(provider);
      appendText(fixture.primaryPath, `${JSON.stringify({ type: "zztest_unknown", timestamp: "2026-06-11T00:00:00.000Z" })}\n`);
      const result = await readProvider(provider, fixture);
      expect(result.sessions.flatMap((session) => session.events).some((event) => event.kind === "unknown")).toBe(false);
      expect(result.diagnostics.some((diagnostic) => /unknown|decode_failed|record/.test(diagnosticBlob(diagnostic)))).toBe(true);
    }, 15_000);
  }

  test("opencode: corrupt sqlite snapshot emits named diagnostic and does not throw", async () => {
    const fixture = withFixture("opencode");
    writeFileSync(fixture.primaryPath, "not sqlite", "utf8");
    const result = await readProvider("opencode", fixture);
    expectNamedDiagnostic(result.diagnostics, "opencode.sqlite.unreadable");
  }, 15_000);

  test("hermes: corrupt sqlite snapshot emits named diagnostic and does not throw", async () => {
    const fixture = withFixture("hermes");
    writeFileSync(fixture.primaryPath, "not sqlite", "utf8");
    const result = await readProvider("hermes", fixture);
    expectNamedDiagnostic(result.diagnostics, "hermes.sqlite.unreadable");
  }, 15_000);

  for (const provider of sqliteProviders) {
    test(`${provider}: unknown row subtype is named and does not pass through`, async () => {
      const fixture = withFixture(provider);
      if (provider === "opencode") {
        execFileSync("sqlite3", [fixture.primaryPath, "insert into part values ('part_unknown', 'msg_assistant', 'ses_fixture061', 199, json_object('type', 'zztest_unknown'));"]);
      } else {
        execFileSync("sqlite3", [fixture.primaryPath, "insert into messages (session_id, role, content, timestamp) values ('20260101_000000_00000061', 'zztest_unknown', 'x', 1999);"]);
      }
      const result = await readProvider(provider, fixture);
      expect(result.sessions.flatMap((session) => session.events).some((event) => event.kind === "unknown")).toBe(false);
      expect(result.diagnostics.some((diagnostic) => /unknown|decode_failed|unmapped/.test(diagnosticBlob(diagnostic)))).toBe(true);
    }, 15_000);
  }

  test("hostile matrix covers all adapters", () => {
    expect(new Set(allProviders).size).toBe(7);
  });
});
