# QSR-056/057/058 — Full-Estate Proof (codex, opencode, hermes, grok + cross-provider unity)

Date: 2026-06-11
Tree: `4ea27bbf85e0dbc9fa73337f2215506ac1b06526` + the uncommitted unity fix
(`packages/core/src/git-identity.ts`, adapter/ingest/convex deltas — deployed to the
backend before this proof ran; commit pending under the build glyph, not this proof)
Backend: self-hosted Convex at `http://127.0.0.1:4210`
Sources: live — claude/codex session files grow while the proof runs (including the
session running it)

Every output below is pasted verbatim from the run. Verdict summary:

| Step | Verdict |
| --- | --- |
| 0. Unity remediation (force re-ingest, precondition) | **DONE** — 2,401 sessions rewritten, 517.28 MB, 36 named diagnostics, 0 failures |
| 1. Full estate, no force | **PASS** — 2,399/2,401 skipped; the 2 rewrites are live claude files |
| 2. Estate table | **PASS** — 2,401 sessions / 48,983 messages / 106,047 toolCalls / 517.28 MB ≪ 1 GB |
| 3. Cross-provider unity | **PASS** — one key `git:github.com/skastr0/quasar` holds claude + codex + grok |
| 4. 105 MB garbage boundary | **PASS** — named diagnostic, zero rows, run continued |
| 5. Cross-provider search | **PASS** — 3 source-verified queries each return hits from ≥ 2 providers |
| 6. Tool-call retrieval | **PASS** — `toolCallsByName(exec_command)` on the unified key returns codex rows |

## Step 0 — Honest precondition: unity was red on arrival, fixed by force re-ingest

The validation swarm's last reading had unity **failing**: quasar sessions split across
`git:github.com/skastr0/quasar` (claude=15, grok=1) and
`path:machine:129e961e0b9e7b47c3c6ed3084b11cd1:6def48b1f9daae76a2e07517e247773c`
(claude=41, codex=152). The identity-ladder fix (git remote before path) was already in
the working tree and deployed, but project identity is derived state baked into rows at
write time — unchanged-fingerprint sessions skip and keep their stale key. The pending
remediation (re-ingest affected providers with `--force`) had not run. I ran it as this
proof's precondition:

```sh
bun run packages/cli/src/cli.ts ingest --provider all --force
```

```json
{
  "ok": true,
  "command": "ingest",
  "data": {
    "providers": [
      {
        "provider": "claude",
        "sessionsWritten": 841,
        "sessionsSkipped": 0,
        "messages": 4748,
        "toolCalls": 11270,
        "diagnostics": [],
        "durationMs": 78614,
        "approxMBWritten": 40.74
      },
      {
        "provider": "codex",
        "sessionsWritten": 589,
        "sessionsSkipped": 0,
        "messages": 23399,
        "toolCalls": 61563,
        "diagnostics": [],
        "durationMs": 300191,
        "approxMBWritten": 263.92
      },
      {
        "provider": "opencode",
        "sessionsWritten": 881,
        "sessionsSkipped": 0,
        "messages": 19005,
        "toolCalls": 31567,
        "diagnostics": "<36 diagnostics — all opencode message.data over the 1 MiB Convex value limit; full verbatim list in step 4>",
        "durationMs": 172110,
        "approxMBWritten": 198.4
      },
      {
        "provider": "hermes",
        "sessionsWritten": 77,
        "sessionsSkipped": 0,
        "messages": 1729,
        "toolCalls": 1583,
        "diagnostics": [],
        "durationMs": 11722,
        "approxMBWritten": 12.8
      },
      {
        "provider": "grok",
        "sessionsWritten": 13,
        "sessionsSkipped": 0,
        "messages": 100,
        "toolCalls": 49,
        "diagnostics": [],
        "durationMs": 2017,
        "approxMBWritten": 1.42
      }
    ],
    "totalSessionsWritten": 2401,
    "totalSessionsSkipped": 0,
    "totalMessages": 48981,
    "totalToolCalls": 106032,
    "totalDiagnostics": 36,
    "totalDurationMs": 564654,
    "totalApproxMBWritten": 517.28
  }
}
```

The whole five-provider estate is **9.4 minutes of sequential writes at 517 MB** — no
TooManyWrites, no retry exhaustion, no invented throttles. `pruneEmptyProjects` then
dropped the abandoned path-keyed project rows (projects: 58 → 50).

Grok note: the plan said "~20 session dirs"; on disk today there are 19 session dirs
across 6 project dirs, of which 13 contain ingestable chat turns — the other 6 are
empty/no-chat machinery dirs, admitted as zero sessions, no diagnostics needed.

## Step 1 — Full estate, no force (idempotency over all five providers)

```sh
bun run packages/cli/src/cli.ts ingest --provider all
```

```json
{
  "ok": true,
  "command": "ingest",
  "data": {
    "providers": [
      {
        "provider": "claude",
        "sessionsWritten": 2,
        "sessionsSkipped": 839,
        "messages": 49,
        "toolCalls": 188,
        "diagnostics": [],
        "durationMs": 13788,
        "approxMBWritten": 0.53
      },
      {
        "provider": "codex",
        "sessionsWritten": 0,
        "sessionsSkipped": 589,
        "messages": 0,
        "toolCalls": 0,
        "diagnostics": [],
        "durationMs": 146207,
        "approxMBWritten": 0
      },
      {
        "provider": "opencode",
        "sessionsWritten": 0,
        "sessionsSkipped": 881,
        "messages": 0,
        "toolCalls": 0,
        "diagnostics": "<the same 36 diagnostics — mapping runs before the skip check, so the garbage boundary re-announces itself on every run; full list in step 4>",
        "durationMs": 24762,
        "approxMBWritten": 0
      },
      {
        "provider": "hermes",
        "sessionsWritten": 0,
        "sessionsSkipped": 77,
        "messages": 0,
        "toolCalls": 0,
        "diagnostics": [],
        "durationMs": 2125,
        "approxMBWritten": 0
      },
      {
        "provider": "grok",
        "sessionsWritten": 0,
        "sessionsSkipped": 13,
        "messages": 0,
        "toolCalls": 0,
        "diagnostics": [],
        "durationMs": 639,
        "approxMBWritten": 0
      }
    ],
    "totalSessionsWritten": 2,
    "totalSessionsSkipped": 2399,
    "totalMessages": 49,
    "totalToolCalls": 188,
    "totalDiagnostics": 36,
    "totalDurationMs": 187521,
    "totalApproxMBWritten": 0.53
  }
}
```

2,399 of 2,401 sessions skipped (99.92%), 0.53 MB rewritten. The 2 claude rewrites are
live session files (this proof's own session among them) whose `sourceFingerprint`
(size+mtime) legitimately changed between step 0 and step 1. codex, opencode, hermes,
grok: 100% skip, zero rows.

**Verdict: PASS.**

## Step 2 — Estate table (Convex ground truth)

Counts aggregated from the live backend (paginated `listProjects` → `listSessions`
walk, summing stored `messageCount`/`toolCallCount`); MB is the measured
`approxMBWritten` of the step-0 full rewrite — every byte of admitted text, freshly
re-measured today:

| Provider | Sessions | Messages | Tool calls | Admitted MB |
| --- | ---: | ---: | ---: | ---: |
| claude   | 841 | 4,750 | 11,285 | 40.74 |
| codex    | 589 | 23,399 | 61,563 | 263.92 |
| opencode | 881 | 19,005 | 31,567 | 198.40 |
| hermes   | 77 | 1,729 | 1,583 | 12.80 |
| grok     | 13 | 100 | 49 | 1.42 |
| **total** | **2,401** | **48,983** | **106,047** | **517.28** |

Verbatim aggregate output:

```json
{
  "projects": 50,
  "totalSessions": 2401,
  "perProvider": {
    "codex": { "sessions": 589, "messages": 23399, "toolCalls": 61563 },
    "opencode": { "sessions": 881, "messages": 19005, "toolCalls": 31567 },
    "grok": { "sessions": 13, "messages": 100, "toolCalls": 49 },
    "claude": { "sessions": 841, "messages": 4750, "toolCalls": 11285 },
    "hermes": { "sessions": 77, "messages": 1729, "toolCalls": 1583 }
  }
}
```

- The claude +2 messages / +15 toolCalls over the step-0 envelope are the step-1 live
  rewrites (49 messages / 188 toolCalls replaced rows that had grown).
- 517.28 MB total sits comfortably under 1 GB — consistent with the plan's ≈ 650 MB
  product-text ceiling (codex 263.92 ≈ measured 240 + estate growth; opencode 198.40 is
  text+tool parts without the 129 MB reasoning double-count; claude 40.74 ≈ 35 + growth).
- Absolute MB, no ratios, no budgets: the only rejection line that fired anywhere is
  Convex's 1 MiB value limit (step 4).

**Verdict: PASS.**

## Step 3 — Cross-provider project unity

Query: `listProjects` filtered to projects whose `rawPaths` contain
`/Users/guilhermecastro/Projects/quasar`, then a full paginated `listSessions` walk per
key. Verbatim:

```json
{
 "totalProjects": 50,
 "quasarProjectKeys": [
  "git:github.com/skastr0/quasar"
 ],
 "git:github.com/skastr0/quasar": {
  "displayName": "quasar",
  "rawPaths": [
   "/Users/guilhermecastro/Projects/quasar"
  ],
  "sessionsByProvider": {
   "claude": 68,
   "codex": 152,
   "grok": 1
  }
 }
}
```

Exactly **one** projectKey for this repository, holding sessions from three providers.
Sample rows under the unified key (one `listSessions` walk, first matches per provider):

```json
[
  {
    "provider": "claude",
    "sessionId": "claude:machine:129e961e0b9e7b47c3c6ed3084b11cd1:75544e7b242de742c736b785b559216c",
    "messageCount": 2,
    "toolCallCount": 25,
    "sourcePath": "~/.claude/projects/-Users-guilhermecastro-Projects-quasar/22f032f0-b764-4a5c-8e16-ea27073b455b/subagents/agent-a31bad8d911b42a07.jsonl"
  },
  {
    "provider": "codex",
    "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:1dd74f2d94e4cd441f23c78b9229873a",
    "messageCount": 808,
    "toolCallCount": 1739,
    "sourcePath": "~/.codex/sessions/2026/06/03/rollout-2026-06-03T21-01-32-019e8fef-6a1b-7f03-b6e1-c03491a77e27.jsonl"
  },
  {
    "provider": "grok",
    "sessionId": "grok:machine:129e961e0b9e7b47c3c6ed3084b11cd1:8a23d72b2c49adacce50c63df5c93716",
    "messageCount": 4,
    "toolCallCount": 0,
    "sourcePath": "~/.grok/sessions/%2FUsers%2Fguilhermecastro%2FProjects%2Fquasar/019eaa4d-89de-70f1-b5c3-8d2ce773042c"
  }
]
```

(opencode and hermes have no sessions for this repository — opencode work happened in
other projects, hermes is a chat agent without a repo cwd. Their unity is the same
mechanism; nothing to show on this key.)

**Verdict: PASS.**

## Step 4 — The garbage boundary: 36 named diagnostics, the 105 MB row first

The infamous opencode row, verbatim from the run envelope:

```json
{
  "provider": "opencode",
  "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:285084e52b318510031e382b5e841f7e",
  "field": "message.data",
  "observedBytes": 105806336
}
```

105,806,336 bytes ≈ 105.8 MB of provider machinery in a single `message` row — two
orders of magnitude past any legitimate session value. Named diagnostic, **zero rows
written for it**, the run continued and ingested the other 880 opencode sessions.

The other 35 diagnostics are the same shape at smaller scale (1,049,663–2,165,425
bytes — every one over Convex's 1 MiB value limit, `CONVEX_MAX_VALUE_BYTES =
1_048_576`, the only rejection line in the codebase). Full list, verbatim:

```json
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:f82ad86b3238465a819c8411ec6b3060", "field": "message.data", "observedBytes": 2149562}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:0556a0b87b16b8e19a10d366de7d6637", "field": "message.data", "observedBytes": 1408235}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ee1bef3d966f78d0ad6a1c5b3af7ae4e", "field": "message.data", "observedBytes": 1545932}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:88703ad9af3f1058634a793b20e8109a", "field": "message.data", "observedBytes": 2053194}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:88703ad9af3f1058634a793b20e8109a", "field": "message.data", "observedBytes": 1552999}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:88703ad9af3f1058634a793b20e8109a", "field": "message.data", "observedBytes": 2165425}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:7181b0b1ad0df2347f02e17f00ee0c4a", "field": "message.data", "observedBytes": 2039773}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:476466bef09ae5ff920c073899af8021", "field": "message.data", "observedBytes": 2036548}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:2e5a532ede54eb9f125d41ac55243615", "field": "message.data", "observedBytes": 1978299}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:161a5616f8162d67ff63e69c140d13bd", "field": "message.data", "observedBytes": 1382219}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:4e96728d381f352c1c24108b3a0c5b9a", "field": "message.data", "observedBytes": 1089819}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:43ae08f93b0019580b4ff5c37283e7ba", "field": "message.data", "observedBytes": 1407935}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:db0c5373f63edf523f160da9968148b8", "field": "message.data", "observedBytes": 1342700}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:e70dfebf8603491ef03cc1cdced157f4", "field": "message.data", "observedBytes": 1361261}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:d4ec09ff608177f2d657ef51e1731b8c", "field": "message.data", "observedBytes": 1067556}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ba39b3b466adffd92a9d468668f1e5f3", "field": "message.data", "observedBytes": 1161113}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:fc63e44bf13f63b6fdcf130d5dbdc9b0", "field": "message.data", "observedBytes": 1141697}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:5cf2864b459f93529ad951b19f167038", "field": "message.data", "observedBytes": 1059379}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:12bb87f941eda88099dd9d27cacf0326", "field": "message.data", "observedBytes": 1059279}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ba7d424ed6e821dfd2d311e01e82ec79", "field": "message.data", "observedBytes": 1286156}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ba7d424ed6e821dfd2d311e01e82ec79", "field": "message.data", "observedBytes": 1317704}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ba7d424ed6e821dfd2d311e01e82ec79", "field": "message.data", "observedBytes": 1626336}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:71466a920ff1bab3f285df64b294b7a5", "field": "message.data", "observedBytes": 1245741}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:36b2547f85f8b44ad81ffd19503e5f8c", "field": "message.data", "observedBytes": 1245741}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:570cabadedd91fb4de7210c325039dfa", "field": "message.data", "observedBytes": 1083754}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:5e9211ce6171a55b64790d9c1e552749", "field": "message.data", "observedBytes": 1761057}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:5e9211ce6171a55b64790d9c1e552749", "field": "message.data", "observedBytes": 1675362}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:3078939ab365c49ba53c35043fd123ad", "field": "message.data", "observedBytes": 1195335}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:6b182b6f6e9c0d7299cbae6d50ee87e0", "field": "message.data", "observedBytes": 1177609}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:e6afd4e4261823b16bf1ed36623ba6f3", "field": "message.data", "observedBytes": 1058084}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:7847f16daa4b55a87f0a788faaf1307a", "field": "message.data", "observedBytes": 1049663}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:f39010004707add58e2dccf68ee9f853", "field": "message.data", "observedBytes": 1142484}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:5b0023445ba5ec2541f19dae4d384f8f", "field": "message.data", "observedBytes": 1410906}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:5b0023445ba5ec2541f19dae4d384f8f", "field": "message.data", "observedBytes": 1105547}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:285084e52b318510031e382b5e841f7e", "field": "message.data", "observedBytes": 105806336}
{"provider": "opencode", "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:cff89371d1ba5c60960261172ec3892e", "field": "message.data", "observedBytes": 1062240}
```

**Verdict: PASS.**

## Step 5 — Cross-provider search (terms source-verified first)

Each term was verified to exist in at least two providers' raw sources before querying:

| Term | claude (jsonl files) | codex (jsonl files) | opencode (text parts) | hermes (messages) |
| --- | ---: | ---: | ---: | ---: |
| redactSensitive | 53 | 135 | 0 | 0 |
| Tower Control | 722 | 476 | 0 | 90 |
| typefully | — | 523 | 118 | — |

(opencode/hermes checked read-only via sqlite; claude/codex/grok via grep.)

Queries ran through `searchMessages` (`limit: 20` — the query's documented max), hits
grouped by the provider prefix of `sessionId`. Verbatim (snippets collapsed to 140
chars by the script):

```json
{
  "query": "redactSensitive",
  "hits": 20,
  "hitsByProvider": { "claude": 18, "codex": 2 },
  "firstHitPerProvider": [
    {
      "provider": "claude",
      "sessionId": "claude:machine:129e961e0b9e7b47c3c6ed3084b11cd1:4444f7f7c8ac0c7624dcb58dc651ae44",
      "seq": 116,
      "role": "assistant",
      "snippet": "Good, contentBlocks are only read, never written to the database. Based on my comprehensive analysis, here are my findings: ## Summary I hav"
    },
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:4eb74851580ce56c84c36db7379c94ea",
      "seq": 281,
      "role": "assistant",
      "snippet": "`^ Source trace complete:` The auxiliary check confirms the difference: `compactText` preserves a Gemini-key-shaped string while `redactSens"
    }
  ]
}
{
  "query": "Tower Control",
  "hits": 20,
  "hitsByProvider": { "codex": 18, "claude": 1, "hermes": 1 },
  "firstHitPerProvider": [
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:ec6df9123858a3e7da9230f44de8a669",
      "seq": 1199,
      "role": "assistant",
      "snippet": "Implemented the first Booth cut as three sibling repos: - [booth-control](/Users/guilhermecastro/Projects/booth-control/README.md): Convex s"
    },
    {
      "provider": "claude",
      "sessionId": "claude:machine:129e961e0b9e7b47c3c6ed3084b11cd1:0a573f2a4736f1c514a62274ce2f379f",
      "seq": 175,
      "role": "assistant",
      "snippet": "All ten files written. `npx next build` succeeds with all four new routes registered (`/operations/dispatches`, `/operations/dependencies`, "
    },
    {
      "provider": "hermes",
      "sessionId": "hermes:machine:129e961e0b9e7b47c3c6ed3084b11cd1:d65d17402699c5c30a3b277ea7463489",
      "seq": 31,
      "role": "assistant",
      "snippet": "Yes — agreed. That earlier conclusion was wrong / overfit to one failed local curl. I loaded the Tailscale SSH/topology skill and re-checked"
    }
  ]
}
{
  "query": "typefully",
  "hits": 20,
  "hitsByProvider": { "opencode": 19, "codex": 1 },
  "firstHitPerProvider": [
    {
      "provider": "opencode",
      "sessionId": "opencode:machine:129e961e0b9e7b47c3c6ed3084b11cd1:02be4089f26ec51c8e9f16af1b30b4d2",
      "seq": 2,
      "role": "reasoning",
      "snippet": "Now I need to perform a comprehensive contract/framework review. Let me analyze each area: 1. **Bun/Effect contract usage** - Check if the c"
    },
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:97bc063d5e201c44e0de12c77d166f3e",
      "seq": 181,
      "role": "assistant",
      "snippet": "**Findings** - Medium: `comments list` will reject a docs-compliant page if Typefully omits `next` or `previous`, because `CommentThreadList"
    }
  ]
}
```

Every query returns hits from at least two providers in a single search; four of the
five providers (claude, codex, opencode, hermes) appear across the three queries. One
candidate recorded honestly: "Tailscale" exists in all five providers' sources but its
top-20 by relevance is 100% codex (306 codex files mention it heavily) — correct
ranking behavior, just not a multi-provider demonstration, so it was swapped out.

**Verdict: PASS.**

## Step 6 — Tool-call retrieval on a codex tool (`toolCallsByName`)

The orchestrating example named `shell`; on this machine's corpus codex's shell tool is
**`exec_command`** (`grep -rl '"name":"shell"'` over codex sources: 0 files;
`'"name":"exec_command"'`: 509 files). Query against the unified quasar key:

```ts
await client.query(api.quasar.toolCallsByName, {
  projectKey: "git:github.com/skastr0/quasar",
  toolName: "exec_command",
  paginationOpts: { numItems: 3, cursor: null },
});
```

Verbatim (prefixes collapsed to 120 chars by the script; `isDone: false` — more pages
exist):

```json
{
  "projectKey": "git:github.com/skastr0/quasar",
  "toolName": "exec_command",
  "isDone": false,
  "rows": [
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:1dd74f2d94e4cd441f23c78b9229873a",
      "seq": 12,
      "status": "completed",
      "inputPrefix": "{\"cmd\":\"pwd\",\"workdir\":\"/Users/guilhermecastro/Projects/quasar\",\"yield_time_ms\":1000,\"max_output_tokens\":2000}",
      "outputPrefix": "Chunk ID: ee0301 Wall time: 0.0000 seconds Process exited with code 0 Original token count: 10 Output: /Users/guilhermec"
    },
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:1dd74f2d94e4cd441f23c78b9229873a",
      "seq": 13,
      "status": "completed",
      "inputPrefix": "{\"cmd\":\"ls\",\"workdir\":\"/Users/guilhermecastro/Projects/quasar\",\"yield_time_ms\":1000,\"max_output_tokens\":4000}",
      "outputPrefix": "Chunk ID: a12e99 Wall time: 0.0000 seconds Process exited with code 0 Original token count: 0 Output:"
    },
    {
      "provider": "codex",
      "sessionId": "codex:machine:129e961e0b9e7b47c3c6ed3084b11cd1:1dd74f2d94e4cd441f23c78b9229873a",
      "seq": 14,
      "status": "completed",
      "inputPrefix": "{\"cmd\":\"rg --files\",\"workdir\":\"/Users/guilhermecastro/Projects/quasar\",\"yield_time_ms\":1000,\"max_output_tokens\":12000}",
      "outputPrefix": "Chunk ID: 7516a7 Wall time: 0.0084 seconds Process exited with code 1 Original token count: 0 Output:"
    }
  ]
}
```

Full codex tool inputs/outputs retrieved by an exact `(projectKey, toolName)` index
walk on the unified cross-provider key — the structural surface, no search involved.

**Verdict: PASS.**

## Overall

The full five-provider estate is live and proven: 2,401 sessions, 48,983 messages,
106,047 tool calls, 517.28 MB of admitted text — under 10 minutes to rewrite from
scratch and a 99.9%-skip no-op to re-run. One project identity per repository across
providers, the 105 MB opencode garbage row rejected at the boundary with a named
diagnostic and zero rows, search answering across providers in single queries, and
codex tool calls retrievable by name on the unified key. The only rejection line that
exists or fired is Convex's own 1 MiB value limit, 36 times, all opencode machinery
rows — exactly what the corpus measurement predicted.
