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

// Real on-disk shape, grounded against ~/.hermes/state.db `.schema`:
//   - sessions.id is TEXT PK (real shape e.g. 20200101_000000_aaaaaaaa)
//   - sessions.source is NOT NULL; started_at is REAL NOT NULL
//   - message_count / tool_call_count / api_call_count default 0
//   - rewind_count / archived are NOT NULL DEFAULT 0
//   - messages.id is INTEGER PRIMARY KEY AUTOINCREMENT (not text)
//   - messages.timestamp is REAL NOT NULL
// Content text below is synthetic — no real session content is copied here.
const SESSION_SCHEMA = `
create table sessions (
  id text primary key,
  source text not null,
  user_id text,
  model text,
  model_config text,
  system_prompt text,
  parent_session_id text,
  started_at real not null,
  ended_at real,
  end_reason text,
  message_count integer default 0,
  tool_call_count integer default 0,
  input_tokens integer default 0,
  output_tokens integer default 0,
  cache_read_tokens integer default 0,
  cache_write_tokens integer default 0,
  reasoning_tokens integer default 0,
  billing_provider text,
  billing_base_url text,
  billing_mode text,
  estimated_cost_usd real,
  actual_cost_usd real,
  cost_status text,
  cost_source text,
  pricing_version text,
  title text,
  api_call_count integer default 0,
  handoff_state text,
  handoff_platform text,
  handoff_error text,
  cwd text,
  rewind_count integer not null default 0,
  archived integer not null default 0,
  foreign key (parent_session_id) references sessions(id)
);
create table messages (
  id integer primary key autoincrement,
  session_id text not null references sessions(id),
  role text not null,
  content text,
  tool_call_id text,
  tool_calls text,
  tool_name text,
  timestamp real not null,
  token_count integer,
  finish_reason text,
  reasoning text,
  reasoning_content text,
  reasoning_details text,
  codex_reasoning_items text,
  codex_message_items text,
  platform_message_id text,
  observed integer default 0,
  active integer not null default 1
);
`;

// sessions.source is NOT NULL in the real schema; "cli" is the canonical value.
const insertSession = (sessionId: string, title: string) =>
  `insert into sessions (id, source, title, cwd, started_at, message_count) values ('${sessionId}', 'cli', '${title}', NULL, 1000, 1);`;

// messages.id is INTEGER AUTOINCREMENT — never supplied. The caller passes a
// label only for documentation; the row's id is assigned by SQLite.
const insertMessage = (_label: string, sessionId: string) =>
  `insert into messages (session_id, role, content, timestamp) values ('${sessionId}', 'user', 'hello from synthetic fixture', 1000);`;

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

  // Both DBs carry the same session id value at different file paths. The id
  // uses the real hermes shape: <YYYYMMDD>_<HHMMSS>_<hex>.
  const IDEM_SESSION_ID = "20200101_000000_aaaaaaaa";
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

  const ALPHA_SESSION_ID = "20200101_000000_bbbbbbbb";
  const BETA_SESSION_ID = "20200101_000000_cccccccc";
  const TOP_SESSION_ID = "20200101_000000_dddddddd";
  execFileSync("sqlite3", [join(profilesDir, "alpha", "state.db"),
    SESSION_SCHEMA + insertSession(ALPHA_SESSION_ID, "Alpha session") + insertMessage("alpha-msg-1", ALPHA_SESSION_ID),
  ]);
  execFileSync("sqlite3", [join(profilesDir, "beta", "state.db"),
    SESSION_SCHEMA + insertSession(BETA_SESSION_ID, "Beta session") + insertMessage("beta-msg-1", BETA_SESSION_ID),
  ]);
  execFileSync("sqlite3", [join(root, "state.db"),
    SESSION_SCHEMA + insertSession(TOP_SESSION_ID, "Top-level session") + insertMessage("top-msg-1", TOP_SESSION_ID),
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
    SESSION_SCHEMA + insertSession("20200101_000000_eeeeeeee", "Only session") + insertMessage("only-msg", "20200101_000000_eeeeeeee"),
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
