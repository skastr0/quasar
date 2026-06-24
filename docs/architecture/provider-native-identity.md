# Provider Native Identity Rules

Every provider harness assigns each session a stable, self-describing identity
that the harness itself maintains. Quasar reads that identity directly from the
content and promotes it into a canonical `SessionId` via:

```
sessionIdFor(provider, nativeSessionId) → "${provider}:${stableWideHash(nativeSessionId)}"
```

Because the native id is sourced from content — not from the file path — the
same session ingested from a host directory and from a Docker `/history` mount
resolves to the same `SessionId` and the store upsert deduplicates it to one
row.

---

## Codex

**Native id source:** the first JSON record of each rollout file. Codex has at
least two measured private first-record formats:

- `legacy_header_v1`: top-level `id` on a record shaped like
  `{ id, timestamp, instructions, git }`.
- `session_meta_v2`: `session_meta.payload.id`.

Both are promoted into the branded `CodexSessionId`.

**Where it lives:** rollout files are named
`rollout-<ISO datetime>-<uuid>.jsonl`. For `session_meta_v2`, the
content-sourced `payload.id` is the canonical key. For `legacy_header_v1`, the
top-level `id` is accepted only when the first record has the measured legacy
header shape and the id is a UUID matching the filename UUID. This intentionally
makes legacy acceptance path-sensitive: the filename UUID is an integrity check
for that legacy format, not the primary id source.

**Boundary rejection:** a rollout file whose first JSON record carries no
recognized native id is rejected with zero rows and a named diagnostic:

- `codex.session_meta.payload.id.missing`
- `codex.session_meta.payload.id.invalid`
- `codex.legacy_header.id.invalid`
- `codex.legacy_header.shape.invalid`
- `codex.legacy_header.project.missing`
- `codex.legacy_header.id.filename_mismatch`
- `codex.first_record.json.invalid`
- `codex.native_session_id.missing`

**Legacy internal drops:** after a `legacy_header_v1` file is accepted, any
later `session_meta` record inside that file is ignored with
`codex.legacy_header.session_meta_ignored` so it cannot alter project identity
or subagent lineage for the legacy session id.

**Legacy project identity:** `legacy_header_v1` project hints are taken only
from the accepted first-record `git` object. A later `session_meta` in the same
legacy file is not a trusted project source. A legacy header whose `git` object
does not carry a usable project path or remote is rejected rather than accepted
into the low-confidence `unknown-project` fallback.

**Why path-independent:** only the in-content uuid enters the hash — never the
parent directory chain. For `session_meta_v2`, two files carrying the same
`session_meta.payload.id` under different parent paths AND different rollout
filenames produce the same `CodexSessionId` and therefore the same `SessionId`.

---

## Claude

**Native id source:** an in-record field read from the JSONL content.  The
field used depends on the file type (polymorphic):

- **Main session file** (`{project}/{uuid}.jsonl`): the `sessionId` field that
  appears in every record of the file.  This is a UUID the Claude harness
  assigns at session creation.
- **Subagent file** (`{parent}/subagents/agent-<uuid>.jsonl`): the `agentId`
  field in the records.  The filename carries an `agent-` prefix that is
  stripped; the underlying uuid is what matters.
- **Workflow-agent file** (`{parent}/subagents/workflows/wf_<run>/agent-<uuid>.jsonl`):
  same as subagent — `agentId` from the records.
- **journal.jsonl**: excluded entirely.  Journal files contain only
  `started`/`result` run manifests with no conversation content.

**Where it lives:** the `sessionId` or `agentId` JSON field in the JSONL
records, not in the file path.

**Why path-independent:** the UUID originates inside the Claude process and is
embedded in every line of the file.  Moving the file to a different directory
or mount point does not change the field value.

---

## Grok

**Native id source:** `basename(sessionDir)` — the name of the session
directory that contains `chat_history.jsonl`.

**Where it lives:** the directory hierarchy under
`{root}/sessions/{projectKey}/{sessionDirName}/`.  The session directory name
is a UUID-like string assigned by the Grok harness.

**Why path-independent:** only the final directory component (the uuid name)
enters the hash — never the `projectKey` component above it and never the
root.  A session directory named `01900000-0000-7000-8000-000000000002` under
`/Users/alice/.grok/...` and the same directory name under `/history/.grok/...`
produce the same `GrokSessionId` and therefore the same `SessionId`.

---

## OpenCode

**Native id source:** the `id` column of the `session` table in
`opencode.sqlite` (or `opencode.db`).

**Where it lives:** the SQLite database file that OpenCode maintains.  The
`id` value is a string like `ses_<random>` set by the OpenCode harness at
session creation.

**Why path-independent:** the id is an intrinsic property of the SQLite row,
not of the file path.  Copying the database to a different location (or
reading it via a different mount) does not change the `session.id` value.

---

## Hermes

**Native id source:** the `id` column of the `sessions` table in
`state.db`.

**Where it lives:** the SQLite state database that Hermes maintains, which may
exist at the root level (`state.db`) or under profile sub-directories
(`profiles/{name}/state.db`).

**Why path-independent:** the id is the primary key of the row, assigned by
the Hermes harness.  The file path of `state.db` does not affect the row's
`id` value.

---

## Kimi

**Native id source:** the `sessionId` field in `session_index.jsonl` at the
root of the Kimi data directory.

**Where it lives:** `{root}/session_index.jsonl` — a flat index that lists
every session with its `sessionId`, `sessionDir`, and `workDir`.  The
`sessionId` is a string such as `session_abc123` assigned by the Kimi harness
at session creation.

**Why path-independent:** the `sessionId` field value is the native id; the
`sessionDir` field (an absolute path that differs between mounts) is used only
to locate the session's wire files on disk.  Two roots that list the same
`sessionId` value in their respective index files produce the same
`KimiSessionId` and therefore the same `SessionId`.

---

## Antigravity

**Native id source:** the uuid directory name under `{root}/brain/` — i.e.,
`basename` of the session's brain directory.

**Where it lives:** `{root}/brain/{uuid}/.system_generated/logs/transcript_full.jsonl`.
The `{uuid}` path component is a standard UUID assigned by the Antigravity CLI
at session creation.

**Why path-independent:** only the uuid directory name enters the hash —
never the brain root path above it.  A session uuid of
`aaaaaaaa-0001-0001-0001-000000000001` under `/Users/alice/.gemini/...` and
the same uuid under `/history/.gemini/...` produce the same
`AntigravitySessionId` and therefore the same `SessionId`.

---

## Store convergence

All seven providers derive their native id from stable content.  Because
`sessionIdFor` is deterministic — it is a hash over `(provider, nativeId)` —
and the store upsert is keyed on `session_id` with `ON CONFLICT DO UPDATE`,
multiple ingest runs for the same physical or logical session always converge
to exactly one row in the `sessions` table.  The `source_path` column reflects
the last writer; no parallel rows accumulate.
