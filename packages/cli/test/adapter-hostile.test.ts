import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, describe, expect, test } from "bun:test";

import { stableAdapters } from "../src/adapters/registry";
import type { AdapterDiagnostic } from "../src/core/schemas";
import {
  adapterFor,
  appendText,
  buildFixtureFor,
  rewriteCursorFixtureUserMessage,
  type AdapterFixture,
  type AdapterProvider,
} from "./adapter-test-harness";

const lineProviders = ["codex", "claude", "grok", "kimi", "antigravity", "omp", "pi"] as const;
const sqliteProviders = ["opencode", "hermes", "cursor", "devin"] as const;
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

/** Exact diagnostic id present in message or details (not a broad regex). */
const expectNamedDiagnostic = (diagnostics: readonly AdapterDiagnostic[], name: string) => {
  expect(diagnostics.some((diagnostic) => diagnosticBlob(diagnostic).includes(name))).toBe(true);
};

/** Exact unknown-record diagnostic ids per line provider (probe-locked). */
const UNKNOWN_RECORD_DIAGNOSTIC: Record<(typeof lineProviders)[number], string> = {
  codex: "codex.unknown_record_type",
  claude: "claude.unknown_type",
  grok: "grok.record.unknown_type",
  kimi: "kimi.wire.decode_failed",
  antigravity: "antigravity.record.decode_failed",
  omp: "omp.record.unknown_type",
  pi: "pi.entry.unknown_type",
};

/** Exact unknown-row diagnostic ids per SQLite provider (probe-locked). */
const UNKNOWN_ROW_DIAGNOSTIC: Record<(typeof sqliteProviders)[number], string> = {
  opencode: "opencode.part.decode_failed",
  hermes: "hermes.message.dropped",
  cursor: "cursor.block.unknown_type",
  devin: "devin.message.role_unsupported",
};

const CORRUPT_SQLITE_DIAGNOSTIC: Record<(typeof sqliteProviders)[number], string> = {
  opencode: "opencode.sqlite.unreadable",
  hermes: "hermes.sqlite.unreadable",
  cursor: "cursor.store.snapshot_failed",
  devin: "devin.sqlite.unreadable",
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
      const expected = provider === "codex"
        ? "codex.native_session_id.missing"
        : provider === "omp"
          ? "omp.session.header_missing"
          : `${provider}.file.empty`;
      expect(result.sessions.length).toBeLessThanOrEqual(1);
      expect(result.diagnostics.some((diagnostic) => diagnosticBlob(diagnostic).includes(expected))).toBe(true);
    }, 15_000);

    test(`${provider}: unreadable primary file emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      chmodSync(fixture.primaryPath, 0);
      try {
        const result = await readProvider(provider, fixture);
        // Codex and OMP own custom open paths; the other line adapters use
        // common.ts and must name unreadable separately from invalid_json.
        const expected = provider === "codex"
          ? "codex.first_record.json.invalid"
          : provider === "omp"
            ? "omp.root.unreadable"
            : `${provider}.line.unreadable`;
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
      expectNamedDiagnostic(result.diagnostics, UNKNOWN_RECORD_DIAGNOSTIC[provider]);
    }, 15_000);
  }

  for (const provider of sqliteProviders) {
    test(`${provider}: corrupt sqlite snapshot emits named diagnostic and does not throw`, async () => {
      const fixture = withFixture(provider);
      writeFileSync(fixture.primaryPath, "not sqlite", "utf8");
      const result = await readProvider(provider, fixture);
      expectNamedDiagnostic(result.diagnostics, CORRUPT_SQLITE_DIAGNOSTIC[provider]);
    }, 15_000);
  }

  for (const provider of sqliteProviders) {
    test(`${provider}: unknown row subtype is named and does not pass through`, async () => {
      const fixture = withFixture(provider);
      if (provider === "opencode") {
        execFileSync("sqlite3", [fixture.primaryPath, "insert into part values ('part_unknown', 'msg_assistant', 'ses_fixture061', 199, json_object('type', 'zztest_unknown'));"]);
      } else if (provider === "hermes") {
        execFileSync("sqlite3", [fixture.primaryPath, "insert into messages (session_id, role, content, timestamp) values ('20260101_000000_00000061', 'zztest_unknown', 'x', 1999);"]);
      } else if (provider === "cursor") {
        rewriteCursorFixtureUserMessage(fixture, {
          role: "user",
          content: [{ type: "zztest_unknown" }],
        });
      } else {
        const chatMessage = Buffer.from(JSON.stringify({
          message_id: "devin-hostile-unknown",
          role: "zztest_unknown",
          content: "must not survive",
          metadata: {
            created_at: "2026-06-11T00:00:00.000Z",
            telemetry: {},
            finish_reason: null,
            is_user_input: null,
            metrics: null,
            num_tokens: null,
            request_id: null,
          },
        }), "utf8").toString("hex");
        execFileSync("sqlite3", [fixture.primaryPath, `
update message_nodes
set chat_message = cast(x'${chatMessage}' as text)
where session_id = 'devin-fixture061' and node_id = 1;
`]);
      }
      const result = await readProvider(provider, fixture);
      expect(result.sessions.flatMap((session) => session.events).some((event) => event.kind === "unknown")).toBe(false);
      expectNamedDiagnostic(result.diagnostics, UNKNOWN_ROW_DIAGNOSTIC[provider]);
      if (provider === "hermes") {
        // Reason string carries the unmapped role; still exact parent diagnostic id above.
        expectNamedDiagnostic(result.diagnostics, "hermes.message.unmapped_role:zztest_unknown");
      }
    }, 15_000);
  }

  test("hostile matrix covers all adapters", () => {
    expect(new Set(allProviders)).toEqual(
      new Set(stableAdapters.map((adapter) => adapter.provider)),
    );
  });
});
