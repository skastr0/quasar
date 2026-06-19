# Embedding retrieval comparison proof — 2026-06-19

This proof compares Quasar retrieval behavior on fixed real agent-session queries. It is intentionally HTTP-level: each named profile points at a running local-server instance, so Gemini and Nomic can be compared without changing the script or mixing vector spaces.

Gemini spend is bounded to query embeddings for this fixed query set when a Gemini-profile server is included. Corpus embedding is not triggered by this script; server-side query embedding cache should make repeated runs no-op for already-seen query text.

JSON artifact: `docs/proofs/embedding-retrieval-comparison-2026-06-19.json`

## Verdict

Synthetic-hosted Nomic is acceptable as the production default for Quasar's bulk session-memory corpus. The 2026-06-18 Gemini baseline and this 2026-06-19 Synthetic/Nomic run use the same five-query proof set and both return relevant session families for project/session retrieval, code/debug text, JSON-ish transcript policy, decision-memory recall, and Mac mini operations proof.

No proof here shows a material retrieval degradation from Nomic for Quasar's actual workload. The strongest operator path remains fusion: lexical search carries exact code/tool/debug snippets, while semantic search provides recall over message meaning. The two vector spaces are intentionally profile-separated and not mixed.

## Query set

| id | category | query | intent |
| --- | --- | --- | --- |
| project-retrieval | project/session retrieval | Quasar local server Effect architecture SQLite LanceDB Docker Tailscale | Find sessions about the Convex-to-Effect local-server architecture shift. |
| code-debug | code/debug text | embedding profile LanceDB messages table vector dimension mismatch | Find sessions/debug work about mixed embedding dimensions and LanceDB table routing. |
| json-transcripts | JSON-ish transcripts | tool call payload messages search surface JSON dump should not be embedded | Find prior reasoning about keeping tool payloads out of semantic message search. |
| decision-memory | decision-memory recall | Convex limits are the contract store at turn grain indexing separate decision | Find the durable architecture rulings that shaped Quasar's data model. |
| operations | operations proof | Mac mini Tailscale IP Docker local server full corpus ingest proof | Find operational proof sessions about Mac mini deployment and full ingest readiness. |

## Profile: synthetic-nomic

Server: `http://<mac-mini-tailscale-ip>:6180`

- HTTP: ok (200, 492ms)
- SQLite: 3712 sessions, 135438 messages, 135176 tool calls
- LanceDB: undefined undefined rows, no indexes
- Embedding cache: 62256 cached, 0 pending
- Queue: 0 pending, 0 leased, 0 failed

### project-retrieval — project/session retrieval

Query: `Quasar local server Effect architecture SQLite LanceDB Docker Tailscale`

Intent: Find sessions about the Convex-to-Effect local-server architecture shift.

#### lexical

Status: ok (200, 528ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 36.4272 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:4ee9c94ad20da1ef782575f8e48445d5 | user/4 | {"content":[{"type":"text","text":"<user_query> Review Forge glyph QSR-106 implementation only. Scope: .dockerignore, platform/local-server/Dockerfile, platform/local-server/compose.yaml, platform/local-server/.env.example, docs/operations/ |
| 2 | 28.2817 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:35bf40e0c7e6bebdb32b600669baeaab | user/2 | {"content":[{"type":"text","text":"Your conversation was summarized due to context constraints. Here is the summary of the conversation so far: <summary_content> ## User goals and constraints - **Quasar is critical infrastructure** — must u |
| 3 | 24.9756 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:d2979bc8b47cafbb2d67140ea8611671 | user/2 | {"type":"user_message","message":"mode: review Repo: /Users/guilhermecastro/Projects/quasar. Context: User is weighing Convex vs Effect+SQLite, HelixDB, LanceDB, Tantivy/Quickwit style search. Goal is SESSION INTELLIGENCE over local AI sess |
| 4 | 24.6764 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:d2979bc8b47cafbb2d67140ea8611671 | user/1 | {"type":"message","role":"user","content":[{"type":"input_text","text":"mode: review Repo: /Users/guilhermecastro/Projects/quasar. Context: User is weighing Convex vs Effect+SQLite, HelixDB, LanceDB, Tantivy/Quickwit style search. Goal is S |
| 5 | 23.5384 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:a8af0515476515463acd13a35bd68e54 | assistant/2986 | {"type":"agent_message","message":"> subagent result @ search architecture :: Convex remains the right durable/control layer, but not the final high-throughput local retrieval engine. Strong stance: keep Convex as truth/readiness/dashboard, |

#### semantic

Status: ok (200, 1436ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.2463 | path:machine:de134fd406c9b3eb261fbf560c52390d:02f6708c6e098459d11ca6ca262bdc8f | claude:machine:de134fd406c9b3eb261fbf560c52390d:6ec77e4b88f2943223b6ebe9a68845a8 | assistant/10 | Quasar is a remote service over Tailscale (the API is at `quasar.<tailnet-suffix>`), with a fallback at `<mac-mini-tailscale-ip>:8179`. The socket is dropping. There's a local convex backend. Let me try the fallback URL, and check if the convex data |
| 2 | -0.2480 | path:machine:de134fd406c9b3eb261fbf560c52390d:02f6708c6e098459d11ca6ca262bdc8f | claude:machine:de134fd406c9b3eb261fbf560c52390d:9d429ebf7a873096b7665cbdea985a5c | assistant/7 | The Quasar API is a remote server (over Tailscale) that's down. There's no local DB to query directly. Let me try the fallback URL to see if the local-network endpoint works, and try a quick connectivity test. |
| 3 | -0.2542 | path:machine:de134fd406c9b3eb261fbf560c52390d:579dfa747d3834d37ce247de246fe0cd | codex:machine:de134fd406c9b3eb261fbf560c52390d:e0af4d6cadcbe46f0776046685bc7721 | assistant/42 | {"type":"agent_message","message":"! Quasar duplicate backend finding :: there are two Quasar Convex backends live: native launchd :: PID 6138, `127.0.0.1:3217/3218`, used by Tailscale Serve Docker/OrbStack :: `quasar-convex-backend-1`, pub |
| 4 | -0.2563 | path:machine:de134fd406c9b3eb261fbf560c52390d:579dfa747d3834d37ce247de246fe0cd | codex:machine:de134fd406c9b3eb261fbf560c52390d:e0af4d6cadcbe46f0776046685bc7721 | assistant/43 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"! Quasar duplicate backend finding :: there are two Quasar Convex backends live: native launchd :: PID 6138, `127.0.0.1:3217/3218`, used by Tailscale Serve Docker |
| 5 | -0.2643 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:5d880b5bff647610ff6cf855abdf0a9a | assistant/95 | {"type":"agent_message","message":"SH::adjustment \| I’m loosening `local:backend` so pure localhost development still works without Tailscale; only Tailscale deploy/build commands require `QUASAR_TAILSCALE_HOST`.","phase":"commentary","memo |

#### fusion

Status: ok (200, 140ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:02f6708c6e098459d11ca6ca262bdc8f | claude:machine:de134fd406c9b3eb261fbf560c52390d:6ec77e4b88f2943223b6ebe9a68845a8 | assistant/10 | Quasar is a remote service over Tailscale (the API is at `quasar.<tailnet-suffix>`), with a fallback at `<mac-mini-tailscale-ip>:8179`. The socket is dropping. There's a local convex backend. Let me try the fallback URL, and check if the convex data |
| 2 | 0.0167 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:4ee9c94ad20da1ef782575f8e48445d5 | user/4 | {"content":[{"type":"text","text":"<user_query> Review Forge glyph QSR-106 implementation only. Scope: .dockerignore, platform/local-server/Dockerfile, platform/local-server/compose.yaml, platform/local-server/.env.example, docs/operations/ |
| 3 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:02f6708c6e098459d11ca6ca262bdc8f | claude:machine:de134fd406c9b3eb261fbf560c52390d:9d429ebf7a873096b7665cbdea985a5c | assistant/7 | The Quasar API is a remote server (over Tailscale) that's down. There's no local DB to query directly. Let me try the fallback URL to see if the local-network endpoint works, and try a quick connectivity test. |
| 4 | 0.0164 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:35bf40e0c7e6bebdb32b600669baeaab | user/2 | {"content":[{"type":"text","text":"Your conversation was summarized due to context constraints. Here is the summary of the conversation so far: <summary_content> ## User goals and constraints - **Quasar is critical infrastructure** — must u |
| 5 | 0.0161 | path:machine:de134fd406c9b3eb261fbf560c52390d:579dfa747d3834d37ce247de246fe0cd | codex:machine:de134fd406c9b3eb261fbf560c52390d:e0af4d6cadcbe46f0776046685bc7721 | assistant/42 | {"type":"agent_message","message":"! Quasar duplicate backend finding :: there are two Quasar Convex backends live: native launchd :: PID 6138, `127.0.0.1:3217/3218`, used by Tailscale Serve Docker/OrbStack :: `quasar-convex-backend-1`, pub |

### code-debug — code/debug text

Query: `embedding profile LanceDB messages table vector dimension mismatch`

Intent: Find sessions/debug work about mixed embedding dimensions and LanceDB table routing.

#### lexical

Status: ok (200, 17ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 36.3069 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:f5435f2a9895ce6366a43fb08fb8bd81 | assistant/5 | **Verdict:** pass **Blocking findings:** none (scoped files) **Q1 — default single-table uses active dimensions?** Yes. `search.ts:72` sets `lexicalDimensions` to `profile.dimensions` when `profileTable === "messages"`; `upsertMessageRows`  |
| 2 | 35.2986 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:ebbea9242f3aadf939a2cb921d4b977f | assistant/5 | ## Verdict **Conditionally acceptable for QSR-112 intent** (split global lexical `messages` vs active profile table for vector/stats/maintenance). Architecture matches the commit message and new tests pass. **One regression risk** on the de |
| 3 | 33.1271 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:69fff294f858a2c93e2a15dad517e207 | assistant/5 | ## Verdict: **needs-work** Commit `e1370a1` implements the split correctly in `search.ts` / `maintenance.ts`, and the new tests pass (`11/11` in `search.test.ts` + `maintenance.test.ts`). They do **not** fully prove profile-specific **vecto |
| 4 | 30.6775 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:d9b8858cf5e02831c364513a005d55b7 | assistant/5 | ## Verdict: **needs work** (Gemini path is mostly right; synthetic/Nomic isolation is incomplete) QSR-110 lands profile identity, cache namespaces, and `vectorDimension` plumbing for **Gemini**. Semantic eligibility policy is **unchanged an |
| 5 | 30.0322 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:ba26581e8227842f14132da4f2072965 | user/4 | {"content":[{"type":"text","text":"<user_query> Re-review QSR-112 after follow-up commit f2c842448ad4f8e6711dab1d685c4a8c31c6377e on top of e1370a1. Focus on whether the prior blocking issue is fixed: single-table profile dimensions, split- |

#### semantic

Status: ok (200, 38ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.2939 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/931 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Verification caught two real gaps. I’m tightening the sequence now: prevent stale-run indexing from mutating LanceDB, and make unconfigured embedding fail closed  |
| 2 | -0.2979 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/930 | {"type":"agent_message","message":"Verification caught two real gaps. I’m tightening the sequence now: prevent stale-run indexing from mutating LanceDB, and make unconfigured embedding fail closed for changed rows so the CLI cannot commit a |
| 3 | -0.2992 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:f5435f2a9895ce6366a43fb08fb8bd81 | assistant/5 | **Verdict:** pass **Blocking findings:** none (scoped files) **Q1 — default single-table uses active dimensions?** Yes. `search.ts:72` sets `lexicalDimensions` to `profile.dimensions` when `profileTable === "messages"`; `upsertMessageRows`  |
| 4 | -0.3134 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/1164 | {"type":"agent_message","message":"+ direct fix option :: make index-on-ingest support lexical-only LanceDB rows when Gemini is unavailable, using zero vectors with a distinct content hash prefix so real embeddings replace them later. That  |
| 5 | -0.3200 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/1156 | {"type":"agent_message","message":"! constraint :: current indexing schema requires vectors for new rows, and the server has no Gemini key. That means “re-ingest + LanceDB index” cannot be completed as-is without either configuring embeddin |

#### fusion

Status: ok (200, 45ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0328 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:f5435f2a9895ce6366a43fb08fb8bd81 | assistant/5 | **Verdict:** pass **Blocking findings:** none (scoped files) **Q1 — default single-table uses active dimensions?** Yes. `search.ts:72` sets `lexicalDimensions` to `profile.dimensions` when `profileTable === "messages"`; `upsertMessageRows`  |
| 2 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/931 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Verification caught two real gaps. I’m tightening the sequence now: prevent stale-run indexing from mutating LanceDB, and make unconfigured embedding fail closed  |
| 3 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:f5cad0c1da923d9a27a2189b69244334 | assistant/930 | {"type":"agent_message","message":"Verification caught two real gaps. I’m tightening the sequence now: prevent stale-run indexing from mutating LanceDB, and make unconfigured embedding fail closed for changed rows so the CLI cannot commit a |
| 4 | 0.0164 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:ebbea9242f3aadf939a2cb921d4b977f | assistant/5 | ## Verdict **Conditionally acceptable for QSR-112 intent** (split global lexical `messages` vs active profile table for vector/stats/maintenance). Architecture matches the commit message and new tests pass. **One regression risk** on the de |
| 5 | 0.0161 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:69fff294f858a2c93e2a15dad517e207 | assistant/5 | ## Verdict: **needs-work** Commit `e1370a1` implements the split correctly in `search.ts` / `maintenance.ts`, and the new tests pass (`11/11` in `search.test.ts` + `maintenance.test.ts`). They do **not** fully prove profile-specific **vecto |

### json-transcripts — JSON-ish transcripts

Query: `tool call payload messages search surface JSON dump should not be embedded`

Intent: Find prior reasoning about keeping tool payloads out of semantic message search.

#### lexical

Status: ok (200, 19ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 28.3150 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:f5f0bf27fa9930c472b5b8e5a3bb82aa | assistant/17 | Now I need to fix two things: 1. Remove the old `const role = roleFromSource(source);` line (role now comes from classification). The `source` variable becomes unused. 2. For terminal PLANNER_RESPONSE with content, we want it as a message.  |
| 2 | 25.6049 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:d1c2c8e36f7b27bc841784b90ea65a1a | assistant/18 | Now I understand the problem. The independent counter is identifying that the adapters are storing machinery dump rows (empty JSON envelopes) as message rows on the search surface, which violates the documented mapping. The product should o |
| 3 | 25.5429 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:32d591abcd4c0ec03357d0b1f19af9b6 | user/0 | Repository: /Users/guilhermecastro/Projects/quasar (bun workspace). FIRST read /Users/guilhermecastro/Projects/quasar/AGENTS.md and /Users/guilhermecastro/Projects/quasar/docs/architecture/quasar-data-reality-plan-2026-06-11.md — short and  |
| 4 | 23.1564 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:ac267cecc21c967fd3d66e82ba20ac75 | assistant/1693 | {"type":"agent_message","message":"> status :: not fully ingested yet uploaded :: `6458/6458` chunks applied :: `821/6458` chunks failed :: `0` corpus :: `510` sessions, `146,943` events, `34,740` tool calls, `156,990` content blocks disk : |
| 5 | 23.1564 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:b7b6902c68b09b1fd27d2d02b700d7c5 | assistant/1693 | {"type":"agent_message","message":"> status :: not fully ingested yet uploaded :: `6458/6458` chunks applied :: `821/6458` chunks failed :: `0` corpus :: `510` sessions, `146,943` events, `34,740` tool calls, `156,990` content blocks disk : |

#### semantic

Status: ok (200, 68ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.2877 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:4c57113432aa5311dff663e270dd610f | user/4 | {"content":[{"type":"text","text":"<user_query> Review the current QSR-109 search-document policy changes in the uncommitted local-server code. Focus only on packages/local-server/src/searchPolicy.ts, ingest.ts, search.ts, maintenance.ts, e |
| 2 | -0.2903 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:b187eedd27c7bf929226a3f3c39c6950 | assistant/2 | Now I understand the core rule: the `messages` table is the search surface (lexical index), and `toolCalls` is the structural surface for tool inputs/outputs. The two-surface rule mandates that tool payloads NEVER appear in message rows, so |
| 3 | -0.2955 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:d1c2c8e36f7b27bc841784b90ea65a1a | assistant/18 | Now I understand the problem. The independent counter is identifying that the adapters are storing machinery dump rows (empty JSON envelopes) as message rows on the search surface, which violates the documented mapping. The product should o |
| 4 | -0.2994 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:03779c134dd99850052f6111e8e2651e | assistant/53 | {"type":"agent_message","message":"⟦shape adjustment⟧ The excess is not the session token scheme; it is tool JSON being turned into an escaped JSON string inside another JSON envelope. I’m switching the contract renderer to search text, not |
| 5 | -0.3001 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:a8af0515476515463acd13a35bd68e54 | assistant/5820 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"> correction :: Convex stores payloads in `json_value`; local search storage alone is ~935M, which is a strong sign of indexed payload pollution from earlier inge |

#### fusion

Status: ok (200, 54ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0325 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:d1c2c8e36f7b27bc841784b90ea65a1a | assistant/18 | Now I understand the problem. The independent counter is identifying that the adapters are storing machinery dump rows (empty JSON envelopes) as message rows on the search surface, which violates the documented mapping. The product should o |
| 2 | 0.0167 | git:github.com/skastr0/quasar | grok:machine:de134fd406c9b3eb261fbf560c52390d:4c57113432aa5311dff663e270dd610f | user/4 | {"content":[{"type":"text","text":"<user_query> Review the current QSR-109 search-document policy changes in the uncommitted local-server code. Focus only on packages/local-server/src/searchPolicy.ts, ingest.ts, search.ts, maintenance.ts, e |
| 3 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:f5f0bf27fa9930c472b5b8e5a3bb82aa | assistant/17 | Now I need to fix two things: 1. Remove the old `const role = roleFromSource(source);` line (role now comes from classification). The `source` variable becomes unused. 2. For terminal PLANNER_RESPONSE with content, we want it as a message.  |
| 4 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:b187eedd27c7bf929226a3f3c39c6950 | assistant/2 | Now I understand the core rule: the `messages` table is the search surface (lexical index), and `toolCalls` is the structural surface for tool inputs/outputs. The two-surface rule mandates that tool payloads NEVER appear in message rows, so |
| 5 | 0.0161 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:32d591abcd4c0ec03357d0b1f19af9b6 | user/0 | Repository: /Users/guilhermecastro/Projects/quasar (bun workspace). FIRST read /Users/guilhermecastro/Projects/quasar/AGENTS.md and /Users/guilhermecastro/Projects/quasar/docs/architecture/quasar-data-reality-plan-2026-06-11.md — short and  |

### decision-memory — decision-memory recall

Query: `Convex limits are the contract store at turn grain indexing separate decision`

Intent: Find the durable architecture rulings that shaped Quasar's data model.

#### lexical

Status: ok (200, 15ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 28.7924 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:6db641804f280f75db59fd32a76d798f | assistant/21 | `resolveProjectIdentity` already exists in the salvage and does exactly what you described — signal hierarchy: explicit key → normalized git remote → package name → workspace → canonical path fallback. Every adapter already stamps `projectI |
| 2 | 25.7675 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:80c4684144cd8b821d902b23182b5fb4 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 3 | 25.7675 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:7ff05be9c6c8077aed750a1bc6fb5e8c | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 4 | 25.7675 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:76c09b35f3938d3603bd9bf790783f08 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 5 | 25.7675 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:c48aca01f4b863d21d5de9e3b821acb4 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |

#### semantic

Status: ok (200, 46ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.2645 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:1b45042e2657dbaf70b36c50c604a6d9 | assistant/22 | **work-done/convex grain** > 42GB point :: conceded fully — that was our data shape (storing what no query consumed, shipping blobs through a transactional engine), not Convex. The audit itself rated the Convex-side code "locally well-craft |
| 2 | -0.2714 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:d4133316a9651949fa4beac0bb83dd6b | assistant/5 | Perfect. Now let me check the Convex value limit more carefully to understand the contract. Let me also look at the data-reality plan mentioned in AGENTS.md: |
| 3 | -0.2877 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:01ba7ece466a9313b7d9d5c8949ae495 | assistant/53 | Let me read the Convex schema — the projects and sessions tables and their indexes are the heart of the A-vs-B decision. |
| 4 | -0.2888 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:d28ff241ab6d2d7e0c7514533ab62f78 | assistant/7 | {"type":"agent_message","message":"The local Convex guidance is present; key constraints for this review are explicit schema/index names, avoiding unbounded embedded lists, strict Id validators, and transaction boundaries for Convex calls.  |
| 5 | -0.2912 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:d6600c1c0b0ff3bff680fb629899e9d5 | assistant/4092 | {"type":"agent_message","message":"! another contract layer :: the current row byte budgets do not equal indexed-field budgets. IDs like `session.id`, `event.id`, and `toolCall.id` are accepted as arbitrary strings by the Effect/Convex boun |

#### fusion

Status: ok (200, 42ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:1b45042e2657dbaf70b36c50c604a6d9 | assistant/22 | **work-done/convex grain** > 42GB point :: conceded fully — that was our data shape (storing what no query consumed, shipping blobs through a transactional engine), not Convex. The audit itself rated the Convex-side code "locally well-craft |
| 2 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:6db641804f280f75db59fd32a76d798f | assistant/21 | `resolveProjectIdentity` already exists in the salvage and does exactly what you described — signal hierarchy: explicit key → normalized git remote → package name → workspace → canonical path fallback. Every adapter already stamps `projectI |
| 3 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:d4133316a9651949fa4beac0bb83dd6b | assistant/5 | Perfect. Now let me check the Convex value limit more carefully to understand the contract. Let me also look at the data-reality plan mentioned in AGENTS.md: |
| 4 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | codex:machine:de134fd406c9b3eb261fbf560c52390d:c48aca01f4b863d21d5de9e3b821acb4 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 5 | 0.0161 | path:machine:de134fd406c9b3eb261fbf560c52390d:6def48b1f9daae76a2e07517e247773c | claude:machine:de134fd406c9b3eb261fbf560c52390d:01ba7ece466a9313b7d9d5c8949ae495 | assistant/53 | Let me read the Convex schema — the projects and sessions tables and their indexes are the heart of the A-vs-B decision. |

### operations — operations proof

Query: `Mac mini Tailscale IP Docker local server full corpus ingest proof`

Intent: Find operational proof sessions about Mac mini deployment and full ingest readiness.

#### lexical

Status: ok (200, 11ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 36.8390 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/62 | {"type":"agent_message","message":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-mini.<tailnet-suffix>` - Tailscale version: |
| 2 | 36.7816 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/63 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-m |
| 3 | 35.9582 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/129 | {"type":"agent_message","message":"**Goal Shape** Use one stable device tag for the Mac mini: ```text tag:mac-mini-server ``` Use Tailscale Services for each app: ```text svc:tower -> https://tower.<tailnet-suffix>/ svc:metrics -> https:// |
| 4 | 35.9276 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/130 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Goal Shape** Use one stable device tag for the Mac mini: ```text tag:mac-mini-server ``` Use Tailscale Services for each app: ```text svc:tower -> https://tower |
| 5 | 35.0640 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:ca77fa0c6d132123c13ac7d681ccbab5 | assistant/453 | {"type":"agent_message","message":"Deleted the verbose file. Relevant shared config fact from `~/Projects/system-setup/system-config.json`: - Both machines use the same Continuwuity runtime shape: `~/.matrix/continuwuity/{.env,compose.yml,d |

#### semantic

Status: ok (200, 40ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.2526 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:20a34f88adfea87f1d7661aa18598d99 | assistant/232 | {"type":"agent_message","message":"Yes. `<mac-mini-tailscale-ip>` is the Mac mini’s **Tailscale IP**. It is **not public internet**. It is in the `100.64.0.0/10` carrier-grade NAT range that Tailscale uses for tailnet addresses. It only routes for de |
| 2 | -0.2542 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:0a051ea749e424b0655b50ed67b49df6 | assistant/37 | {"type":"agent_message","message":"**Assessment** Tailscale itself does not look broken on the Mac mini. This shell is running on `macmini.local`, and its local Tailscale IP is `<mac-mini-tailscale-ip>`. That matters because the earlier “from this cl |
| 3 | -0.2611 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:0a051ea749e424b0655b50ed67b49df6 | assistant/38 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Assessment** Tailscale itself does not look broken on the Mac mini. This shell is running on `macmini.local`, and its local Tailscale IP is `<mac-mini-tailscale-ip>`. Tha |
| 4 | -0.2612 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:20a34f88adfea87f1d7661aa18598d99 | assistant/233 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Yes. `<mac-mini-tailscale-ip>` is the Mac mini’s **Tailscale IP**. It is **not public internet**. It is in the `100.64.0.0/10` carrier-grade NAT range that Tailscale uses f |
| 5 | -0.2698 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:0a051ea749e424b0655b50ed67b49df6 | assistant/22 | {"type":"agent_message","message":"I found the main source of confusion: this shell is running on `macmini.local`, not on the MacBook. `<mac-mini-tailscale-ip>` is the local Tailscale IP here, so the successful `nc` and `curl` I just ran only prove t |

#### fusion

Status: ok (200, 48ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:20a34f88adfea87f1d7661aa18598d99 | assistant/232 | {"type":"agent_message","message":"Yes. `<mac-mini-tailscale-ip>` is the Mac mini’s **Tailscale IP**. It is **not public internet**. It is in the `100.64.0.0/10` carrier-grade NAT range that Tailscale uses for tailnet addresses. It only routes for de |
| 2 | 0.0167 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/62 | {"type":"agent_message","message":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-mini.<tailnet-suffix>` - Tailscale version: |
| 3 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:0a051ea749e424b0655b50ed67b49df6 | assistant/37 | {"type":"agent_message","message":"**Assessment** Tailscale itself does not look broken on the Mac mini. This shell is running on `macmini.local`, and its local Tailscale IP is `<mac-mini-tailscale-ip>`. That matters because the earlier “from this cl |
| 4 | 0.0164 | path:machine:de134fd406c9b3eb261fbf560c52390d:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:de134fd406c9b3eb261fbf560c52390d:90087fe28ea35c350906e2f8ec3b83fb | assistant/63 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-m |
| 5 | 0.0161 | path:machine:de134fd406c9b3eb261fbf560c52390d:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:de134fd406c9b3eb261fbf560c52390d:0a051ea749e424b0655b50ed67b49df6 | assistant/38 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Assessment** Tailscale itself does not look broken on the Mac mini. This shell is running on `macmini.local`, and its local Tailscale IP is `<mac-mini-tailscale-ip>`. Tha |

## Interpretation checklist

- Nomic is accepted for the Mac mini production default because it retrieves the same relevant session families across the fixed query set when compared to the 2026-06-18 Gemini baseline.
- Prefer fusion for operator use when lexical/code snippets matter; semantic-only is a recall aid, not the sole retrieval surface.
- Re-run this proof with side-by-side `gemini=<url>` and `nomic=<url>` profiles before changing embedding defaults for a materially different corpus or retrieval task.
