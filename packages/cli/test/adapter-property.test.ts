import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import * as fc from "effect/FastCheck";

import { stableAdapters } from "../src/adapters/registry";
import type { AdapterDiagnostic, NormalizedSession } from "../src/core/schemas";
import {
  adapterFor,
  appendText,
  buildFixtureFor,
  type AdapterFixture,
  type AdapterProvider,
  writeJsonLines,
} from "./adapter-test-harness";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type MutationKind = "drop_required_field" | "wrong_type" | "unknown_type";

const sql = (value: string) => value.replaceAll("'", "''");

const injectMutation = (
  provider: AdapterProvider,
  fixture: AdapterFixture,
  mutation: MutationKind,
) => {
  switch (provider) {
    case "codex":
      appendText(fixture.primaryPath, `${JSON.stringify(
        mutation === "unknown_type"
          ? { timestamp: "2026-06-11T00:00:00.000Z", type: "response_item", payload: { type: "zztest_unknown" } }
          : mutation === "wrong_type"
            ? { timestamp: "2026-06-11T00:00:00.000Z", type: "response_item", payload: { type: "message", role: 5, content: [] } }
            : { timestamp: "2026-06-11T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user" } },
      )}\n`);
      return;
    case "claude":
      appendText(fixture.primaryPath, `${JSON.stringify(
        mutation === "unknown_type"
          ? { type: "zztest_unknown", sessionId: "aaaa1111-0001-4001-8001-000000000061" }
          : mutation === "wrong_type"
            ? { type: "user", sessionId: "aaaa1111-0001-4001-8001-000000000061", message: { role: 5 } }
            : { type: "user", sessionId: "aaaa1111-0001-4001-8001-000000000061" },
      )}\n`);
      return;
    case "opencode":
      execFileSync("sqlite3", [fixture.primaryPath, `
insert into part values ('part_mut_${mutation}', 'msg_assistant', 'ses_fixture061', 99, '${sql(JSON.stringify(
        mutation === "unknown_type"
          ? { type: "zztest_unknown" }
          : mutation === "wrong_type"
            ? { type: "text", text: 5 }
            : { type: "tool" },
      ))}');
`]);
      return;
    case "grok":
      appendText(fixture.primaryPath, `${JSON.stringify(
        mutation === "unknown_type"
          ? { type: "zztest_unknown", content: "x" }
          : mutation === "wrong_type"
            ? { type: "user", content: 5 }
            : { type: "assistant" },
      )}\n`);
      return;
    case "hermes":
      execFileSync("sqlite3", [fixture.primaryPath, `
insert into messages (session_id, role, content, timestamp) values ('20260101_000000_00000061', '${mutation === "unknown_type" ? "zztest_unknown" : "user"}', ${mutation === "wrong_type" ? "5" : "NULL"}, 1099);
`]);
      return;
    case "kimi":
      appendText(fixture.primaryPath, `${JSON.stringify(
        mutation === "unknown_type"
          ? { type: "zztest_unknown", time: 1099 }
          : mutation === "wrong_type"
            ? { type: "context.append_message", time: "bad", message: { role: "user", content: [] } }
            : { type: "context.append_message", time: 1099 },
      )}\n`);
      return;
    case "antigravity":
      appendText(fixture.primaryPath, `${JSON.stringify(
        mutation === "unknown_type"
          ? { type: "ZZTEST_UNKNOWN", created_at: "2026-06-11T00:00:00.000Z" }
          : mutation === "wrong_type"
            ? { type: "USER_INPUT", created_at: 5, content: "bad" }
            : { type: "USER_INPUT", created_at: "2026-06-11T00:00:00.000Z" },
      )}\n`);
      return;
  }
};

const diagnosticHasName = (diagnostic: AdapterDiagnostic) => {
  const details = diagnostic.details;
  const maybeName =
    details !== null && typeof details === "object"
      ? (details as { readonly diagnostic?: unknown; readonly diagnostics?: unknown }).diagnostic
      : undefined;
  return (
    typeof maybeName === "string" ||
    /[a-z]+(?:\.[a-z_]+)+/.test(diagnostic.message) ||
    JSON.stringify(details ?? {}).includes(".")
  );
};

const assertNoUnknownKind = (sessions: readonly NormalizedSession[]) => {
  for (const session of sessions) {
    expect(session.events.some((event) => event.kind === "unknown")).toBe(false);
  }
};

const signalCount = (sessions: readonly NormalizedSession[]) =>
  sessions.reduce(
    (total, session) => total + session.events.length + session.toolCalls.length + session.sessionEdges.length,
    0,
  );

const namedDiagnosticCount = (diagnostics: readonly AdapterDiagnostic[]) =>
  diagnostics.filter(diagnosticHasName).length;

describe("adapter property invariants", () => {
  test("mutated provider records never throw, never emit unknown-kind, and named drops stay named", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...stableAdapters.map((adapter) => adapter.provider)),
        fc.constantFrom<MutationKind>("drop_required_field", "wrong_type", "unknown_type"),
        async (provider, mutation) => {
          const root = mkdtempSync(join(tmpdir(), `quasar-${provider}-property-`));
          tempRoots.push(root);
          const fixture = buildFixtureFor(provider, root);
          const adapter = adapterFor(provider);
          const options = {
            machine: { machineId: "machine:test", hostname: "test-host", platform: "darwin" },
            now: "2026-06-11T00:00:00.000Z",
            roots: { [provider]: fixture.root },
            logicalRoots: { [provider]: fixture.logicalRoot },
          };
          const before = await adapter.read(options);
          injectMutation(provider, fixture, mutation);
          const result = await adapter.read(options);
          assertNoUnknownKind(result.sessions);
          expect(
            signalCount(result.sessions) > signalCount(before.sessions) ||
              namedDiagnosticCount(result.diagnostics) > namedDiagnosticCount(before.diagnostics),
          ).toBe(true);
          for (const diagnostic of result.diagnostics.filter((item) => item.status === "error" || item.status === "unsupported")) {
            expect(diagnosticHasName(diagnostic)).toBe(true);
          }
        },
      ),
      { seed: 8675309, numRuns: 35 },
    );
  }, 30_000);
});
