import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";

import { hermesAdapter } from "../src/adapters/hermes";

const MACHINE = {
  machineId: "machine:test",
  hostname: "test-host",
  platform: "darwin",
};

const NOW = "2026-06-11T00:00:00.000Z";

const SESSION_SCHEMA = `
create table sessions (
  id text primary key,
  model text,
  parent_session_id text,
  started_at integer,
  ended_at integer,
  input_tokens integer,
  output_tokens integer,
  cache_read_tokens integer,
  cache_write_tokens integer,
  reasoning_tokens integer,
  billing_provider text,
  estimated_cost_usd real,
  actual_cost_usd real,
  title text,
  cwd text
);
create table messages (
  id text primary key,
  session_id text,
  role text,
  content text,
  tool_call_id text,
  tool_calls text,
  tool_name text,
  timestamp integer,
  token_count integer,
  finish_reason text,
  reasoning text,
  reasoning_content text,
  reasoning_details text,
  codex_reasoning_items text,
  codex_message_items text,
  platform_message_id text
);
`;

const insertSession = (sessionId: string, title: string) =>
  `insert into sessions (id, title, cwd, started_at) values ('${sessionId}', '${title}', NULL, 1000);`;

const insertMessage = (messageId: string, sessionId: string) =>
  `insert into messages (id, session_id, role, content, timestamp) values ('${messageId}', '${sessionId}', 'user', 'hello', 1000);`;

// Root for all tests — cleaned up once at the end
const testRoot = mkdtempSync(join(tmpdir(), "quasar-hermes-test-"));

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// AC#5 — idempotency proof (content-id provider, sessions.id DB column)
//
// Hermes native id = `sessions.id` column value from the SQLite state.db.
// Two DB files at DIFFERENT root paths containing the SAME session id must
// resolve to byte-identical canonical session.id values.
// ---------------------------------------------------------------------------
describe("AC#5 idempotency: same sessions.id at different DB paths → byte-identical session.id", () => {
  const hostRoot = join(testRoot, "idem-host");
  const dockerRoot = join(testRoot, "idem-docker");
  mkdirSync(hostRoot, { recursive: true });
  mkdirSync(dockerRoot, { recursive: true });

  // Both DBs carry the same session id value at different file paths.
  const IDEM_SESSION_ID = "hermes-idem-session-001";
  execFileSync("sqlite3", [join(hostRoot, "state.db"),
    SESSION_SCHEMA + insertSession(IDEM_SESSION_ID, "Idempotency session host") + insertMessage(`${IDEM_SESSION_ID}-msg`, IDEM_SESSION_ID),
  ]);
  execFileSync("sqlite3", [join(dockerRoot, "state.db"),
    SESSION_SCHEMA + insertSession(IDEM_SESSION_ID, "Idempotency session docker") + insertMessage(`${IDEM_SESSION_ID}-msg`, IDEM_SESSION_ID),
  ]);

  test(
    "host and docker reads produce byte-identical session.id",
    async () => {
      const hostResult = await hermesAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { hermes: hostRoot },
      });
      const dockerResult = await hermesAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { hermes: dockerRoot },
      });

      expect(hostResult.sessions).toHaveLength(1);
      expect(dockerResult.sessions).toHaveLength(1);
      // Canonical session.id must be byte-identical regardless of which
      // file path the state.db lives at.
      expect(hostResult.sessions[0]!.id).toBe(dockerResult.sessions[0]!.id);
      // sourcePaths differ — proving the id is path-independent.
      expect(hostResult.sessions[0]!.sourcePath).not.toBe(dockerResult.sessions[0]!.sourcePath);
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// T1: multi-profile layout
// ---------------------------------------------------------------------------
describe("T1: multi-profile layout", () => {
  const root = join(testRoot, "t1");
  const profilesDir = join(root, "profiles");

  // Create profiles/alpha/state.db, profiles/beta/state.db, and top-level state.db
  mkdirSync(join(profilesDir, "alpha"), { recursive: true });
  mkdirSync(join(profilesDir, "beta"), { recursive: true });

  execFileSync("sqlite3", [join(profilesDir, "alpha", "state.db"),
    SESSION_SCHEMA + insertSession("alpha-session-1", "Alpha session") + insertMessage("alpha-msg-1", "alpha-session-1"),
  ]);
  execFileSync("sqlite3", [join(profilesDir, "beta", "state.db"),
    SESSION_SCHEMA + insertSession("beta-session-1", "Beta session") + insertMessage("beta-msg-1", "beta-session-1"),
  ]);
  execFileSync("sqlite3", [join(root, "state.db"),
    SESSION_SCHEMA + insertSession("top-session-1", "Top-level session") + insertMessage("top-msg-1", "top-session-1"),
  ]);

  test(
    "discovers 3 sessions, one per profile, with correct projectIdentityKey",
    async () => {
      const result = await hermesAdapter.read({
        machine: MACHINE,
        now: NOW,
        roots: { hermes: root },
      });

      expect(result.sessions).toHaveLength(3);

      const keys = result.sessions.map((s) => s.projectIdentity.projectIdentityKey).sort();
      expect(keys).toEqual([
        "project:profile:alpha",
        "project:profile:beta",
        "project:profile:hermes",
      ]);

      // None should be path:-prefixed
      for (const session of result.sessions) {
        expect(session.projectIdentity.projectIdentityKey).not.toMatch(/^project:path:/);
      }
    },
    15_000,
  );
});

// ---------------------------------------------------------------------------
// T2: top-level only
// ---------------------------------------------------------------------------
describe("T2: top-level only (no profiles directory)", () => {
  const root = join(testRoot, "t2");
  mkdirSync(root, { recursive: true });

  execFileSync("sqlite3", [join(root, "state.db"),
    SESSION_SCHEMA + insertSession("only-session", "Only session") + insertMessage("only-msg", "only-session"),
  ]);

  test("discovers 1 session keyed project:profile:hermes", async () => {
    const result = await hermesAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { hermes: root },
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.projectIdentity.projectIdentityKey).toBe("project:profile:hermes");
  });
});

// ---------------------------------------------------------------------------
// T3: empty root (no state.db, no profiles)
// ---------------------------------------------------------------------------
describe("T3: empty root", () => {
  const root = join(testRoot, "t3");
  mkdirSync(root, { recursive: true });

  test("yields no sessions and emits a no_data_found diagnostic", async () => {
    const result = await hermesAdapter.read({
      machine: MACHINE,
      now: NOW,
      roots: { hermes: root },
    });

    expect(result.sessions).toHaveLength(0);
    const noData = result.diagnostics.filter((d) => d.status === "no_data_found");
    expect(noData.length).toBeGreaterThanOrEqual(1);
  });
});
