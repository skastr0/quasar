# Embedding retrieval comparison proof — 2026-06-18

This proof compares Quasar retrieval behavior on fixed real agent-session queries. It is intentionally HTTP-level: each named profile points at a running local-server instance, so Gemini and Nomic can be compared without changing the script or mixing vector spaces.

Gemini spend is bounded to query embeddings for this fixed query set when a Gemini-profile server is included. Corpus embedding is not triggered by this script; server-side query embedding cache should make repeated runs no-op for already-seen query text.

JSON artifact: `docs/proofs/embedding-retrieval-comparison-2026-06-18.json`

## Query set

| id | category | query | intent |
| --- | --- | --- | --- |
| project-retrieval | project/session retrieval | Quasar local server Effect architecture SQLite LanceDB Docker Tailscale | Find sessions about the Convex-to-Effect local-server architecture shift. |
| code-debug | code/debug text | embedding profile LanceDB messages table vector dimension mismatch | Find sessions/debug work about mixed embedding dimensions and LanceDB table routing. |
| json-transcripts | JSON-ish transcripts | tool call payload messages search surface JSON dump should not be embedded | Find prior reasoning about keeping tool payloads out of semantic message search. |
| decision-memory | decision-memory recall | Convex limits are the contract store at turn grain indexing separate decision | Find the durable architecture rulings that shaped Quasar's data model. |
| operations | operations proof | Mac mini Tailscale IP Docker local server full corpus ingest proof | Find operational proof sessions about Mac mini deployment and full ingest readiness. |

## Profile: gemini-current

Server: `http://<mac-mini-tailscale-ip>:6180`

- HTTP: ok (200, 269ms)
- SQLite: 3699 sessions, 135328 messages, 134940 tool calls
- LanceDB: messages 124686 rows, vector_idx, text_idx
- Embedding cache: 124684 cached, 0 pending
- Queue: 2 pending, 0 leased, 0 failed

### project-retrieval — project/session retrieval

Query: `Quasar local server Effect architecture SQLite LanceDB Docker Tailscale`

Intent: Find sessions about the Convex-to-Effect local-server architecture shift.

#### lexical

Status: ok (200, 174ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 36.4311 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:4ee9c94ad20da1ef782575f8e48445d5 | user/4 | {"content":[{"type":"text","text":"<user_query> Review Forge glyph QSR-106 implementation only. Scope: .dockerignore, platform/local-server/Dockerfile, platform/local-server/compose.yaml, platform/local-server/.env.example, docs/operations/ |
| 2 | 28.2508 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:35bf40e0c7e6bebdb32b600669baeaab | user/2 | {"content":[{"type":"text","text":"Your conversation was summarized due to context constraints. Here is the summary of the conversation so far: <summary_content> ## User goals and constraints - **Quasar is critical infrastructure** — must u |
| 3 | 24.9613 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d2979bc8b47cafbb2d67140ea8611671 | user/2 | {"type":"user_message","message":"mode: review Repo: /Users/guilhermecastro/Projects/quasar. Context: User is weighing Convex vs Effect+SQLite, HelixDB, LanceDB, Tantivy/Quickwit style search. Goal is SESSION INTELLIGENCE over local AI sess |
| 4 | 24.6610 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d2979bc8b47cafbb2d67140ea8611671 | user/1 | {"type":"message","role":"user","content":[{"type":"input_text","text":"mode: review Repo: /Users/guilhermecastro/Projects/quasar. Context: User is weighing Convex vs Effect+SQLite, HelixDB, LanceDB, Tantivy/Quickwit style search. Goal is S |
| 5 | 23.5395 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:ac267cecc21c967fd3d66e82ba20ac75 | assistant/1565 | {"type":"agent_message","message":"> subagent result @ search architecture :: Convex remains the right durable/control layer, but not the final high-throughput local retrieval engine. Strong stance: keep Convex as truth/readiness/dashboard, |

#### semantic

Status: ok (200, 4899ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.1456 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/454 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for |
| 2 | -0.1492 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/453 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |
| 3 | -0.1492 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:976606cc5e0399bf6c195eca20cd551d | assistant/261 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |
| 4 | -0.1492 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:858a7014f27484bfba4cc48a1b598f95 | assistant/261 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |
| 5 | -0.1492 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:441aeacce823d33faab2041abae7cb0d | assistant/261 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |

#### fusion

Status: ok (200, 189ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/454 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for |
| 2 | 0.0167 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:4ee9c94ad20da1ef782575f8e48445d5 | user/4 | {"content":[{"type":"text","text":"<user_query> Review Forge glyph QSR-106 implementation only. Scope: .dockerignore, platform/local-server/Dockerfile, platform/local-server/compose.yaml, platform/local-server/.env.example, docs/operations/ |
| 3 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/453 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |
| 4 | 0.0164 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:35bf40e0c7e6bebdb32b600669baeaab | user/2 | {"content":[{"type":"text","text":"Your conversation was summarized due to context constraints. Here is the summary of the conversation so far: <summary_content> ## User goals and constraints - **Quasar is critical infrastructure** — must u |
| 5 | 0.0161 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:976606cc5e0399bf6c195eca20cd551d | assistant/261 | {"type":"agent_message","message":"= plinth shape :: it is indeed Bun + Effect + local SQLite, with explicit raw-store/artifact-store concepts. I’m reading the architecture sections that matter for whether Quasar should become more like tha |

### code-debug — code/debug text

Query: `embedding profile LanceDB messages table vector dimension mismatch`

Intent: Find sessions/debug work about mixed embedding dimensions and LanceDB table routing.

#### lexical

Status: ok (200, 16ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 24.2425 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:35bf40e0c7e6bebdb32b600669baeaab | assistant/3 | You are not giving up meaningful search quality by choosing LanceDB over Qdrant for Quasar. You are trading Qdrant’s query-composition ergonomics and a few advanced retrieval patterns you do not need at this scale. ## RRF: yours vs LanceDB  |
| 2 | 23.9569 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | assistant/25 | {"type":"agent_message","message":"Verdict: needs-work. - Blocking, high: [packages/search/test/lancedb.test.ts#L97](/Users/guilhermecastro/Projects/quasar/packages/search/test/lancedb.test.ts#L97) and [packages/search/test/lancedb.test.ts# |
| 3 | 23.8538 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | assistant/26 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Verdict: needs-work. - Blocking, high: [packages/search/test/lancedb.test.ts#L97](/Users/guilhermecastro/Projects/quasar/packages/search/test/lancedb.test.ts#L97) |
| 4 | 23.4028 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | user/2 | {"type":"user_message","message":"Review QSR-073 verification in /Users/guilhermecastro/Projects/quasar. Do not edit files. Scope: LanceDB search package changes. Check whether tests prove acceptance criteria: create table and FTS/vector in |
| 5 | 23.3200 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/2053 | {"type":"agent_message","message":"**Executive Summary** Branch: `lancedb-search-unblock` HEAD: `c5d3b79 test(search): prove lancedb backend stability` Worktree: clean This branch replaces the crashed Convex Searchlight/RAG search path with |

#### semantic

Status: ok (200, 444ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.1583 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/1156 | {"type":"agent_message","message":"! constraint :: current indexing schema requires vectors for new rows, and the server has no Gemini key. That means “re-ingest + LanceDB index” cannot be completed as-is without either configuring embeddin |
| 2 | -0.1614 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/1157 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"! constraint :: current indexing schema requires vectors for new rows, and the server has no Gemini key. That means “re-ingest + LanceDB index” cannot be complete |
| 3 | -0.1735 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/1137 | {"type":"agent_message","message":"= final shape of the incident :: deploy pushed code, then restart got trapped bootstrapping the old corpus/search/vector state. The largest table is vectors (~841 MB); second is RAG/search docs (~533 MB);  |
| 4 | -0.1735 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:976606cc5e0399bf6c195eca20cd551d | assistant/625 | {"type":"agent_message","message":"= final shape of the incident :: deploy pushed code, then restart got trapped bootstrapping the old corpus/search/vector state. The largest table is vectors (~841 MB); second is RAG/search docs (~533 MB);  |
| 5 | -0.1735 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:441aeacce823d33faab2041abae7cb0d | assistant/625 | {"type":"agent_message","message":"= final shape of the incident :: deploy pushed code, then restart got trapped bootstrapping the old corpus/search/vector state. The largest table is vectors (~841 MB); second is RAG/search docs (~533 MB);  |

#### fusion

Status: ok (200, 76ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/1156 | {"type":"agent_message","message":"! constraint :: current indexing schema requires vectors for new rows, and the server has no Gemini key. That means “re-ingest + LanceDB index” cannot be completed as-is without either configuring embeddin |
| 2 | 0.0167 | git:github.com/skastr0/quasar | grok:machine:76e148fc65f0750b08e057de1f1c3755:35bf40e0c7e6bebdb32b600669baeaab | assistant/3 | You are not giving up meaningful search quality by choosing LanceDB over Qdrant for Quasar. You are trading Qdrant’s query-composition ergonomics and a few advanced retrieval patterns you do not need at this scale. ## RRF: yours vs LanceDB  |
| 3 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/1157 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"! constraint :: current indexing schema requires vectors for new rows, and the server has no Gemini key. That means “re-ingest + LanceDB index” cannot be complete |
| 4 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | assistant/25 | {"type":"agent_message","message":"Verdict: needs-work. - Blocking, high: [packages/search/test/lancedb.test.ts#L97](/Users/guilhermecastro/Projects/quasar/packages/search/test/lancedb.test.ts#L97) and [packages/search/test/lancedb.test.ts# |
| 5 | 0.0161 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/1137 | {"type":"agent_message","message":"= final shape of the incident :: deploy pushed code, then restart got trapped bootstrapping the old corpus/search/vector state. The largest table is vectors (~841 MB); second is RAG/search docs (~533 MB);  |

### json-transcripts — JSON-ish transcripts

Query: `tool call payload messages search surface JSON dump should not be embedded`

Intent: Find prior reasoning about keeping tool payloads out of semantic message search.

#### lexical

Status: ok (200, 30ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 28.3156 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:f5f0bf27fa9930c472b5b8e5a3bb82aa | assistant/17 | Now I need to fix two things: 1. Remove the old `const role = roleFromSource(source);` line (role now comes from classification). The `source` variable becomes unused. 2. For terminal PLANNER_RESPONSE with content, we want it as a message.  |
| 2 | 25.5923 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:d1c2c8e36f7b27bc841784b90ea65a1a | assistant/18 | Now I understand the problem. The independent counter is identifying that the adapters are storing machinery dump rows (empty JSON envelopes) as message rows on the search surface, which violates the documented mapping. The product should o |
| 3 | 25.4957 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:32d591abcd4c0ec03357d0b1f19af9b6 | user/0 | Repository: /Users/guilhermecastro/Projects/quasar (bun workspace). FIRST read /Users/guilhermecastro/Projects/quasar/AGENTS.md and /Users/guilhermecastro/Projects/quasar/docs/architecture/quasar-data-reality-plan-2026-06-11.md — short and  |
| 4 | 23.1303 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:7dbb84e8bb7cd7c3eed45c7e343d1159 | assistant/1693 | {"type":"agent_message","message":"> status :: not fully ingested yet uploaded :: `6458/6458` chunks applied :: `821/6458` chunks failed :: `0` corpus :: `510` sessions, `146,943` events, `34,740` tool calls, `156,990` content blocks disk : |
| 5 | 23.1303 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:ac267cecc21c967fd3d66e82ba20ac75 | assistant/1693 | {"type":"agent_message","message":"> status :: not fully ingested yet uploaded :: `6458/6458` chunks applied :: `821/6458` chunks failed :: `0` corpus :: `510` sessions, `146,943` events, `34,740` tool calls, `156,990` content blocks disk : |

#### semantic

Status: ok (200, 613ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.1392 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:03779c134dd99850052f6111e8e2651e | assistant/53 | {"type":"agent_message","message":"⟦shape adjustment⟧ The excess is not the session token scheme; it is tool JSON being turned into an escaped JSON string inside another JSON envelope. I’m switching the contract renderer to search text, not |
| 2 | -0.1406 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:03779c134dd99850052f6111e8e2651e | assistant/54 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"⟦shape adjustment⟧ The excess is not the session token scheme; it is tool JSON being turned into an escaped JSON string inside another JSON envelope. I’m switchin |
| 3 | -0.1427 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/7038 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"> Re `summary.diffs`: yes, that is provider display/reconciliation metadata unless it is emitted as an explicit session event/tool result. It should not become a  |
| 4 | -0.1446 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:de8f6d0cf9328f3fb80bdfd20f0c6095 | assistant/3630 | {"type":"agent_message","message":"> Re `summary.diffs`: yes, that is provider display/reconciliation metadata unless it is emitted as an explicit session event/tool result. It should not become a searchable content block, artifact, chunk i |
| 5 | -0.1446 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d00a6958baf65943fbf09e6e279238b9 | assistant/3630 | {"type":"agent_message","message":"> Re `summary.diffs`: yes, that is provider display/reconciliation metadata unless it is emitted as an explicit session event/tool result. It should not become a searchable content block, artifact, chunk i |

#### fusion

Status: ok (200, 74ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:03779c134dd99850052f6111e8e2651e | assistant/53 | {"type":"agent_message","message":"⟦shape adjustment⟧ The excess is not the session token scheme; it is tool JSON being turned into an escaped JSON string inside another JSON envelope. I’m switching the contract renderer to search text, not |
| 2 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:f5f0bf27fa9930c472b5b8e5a3bb82aa | assistant/17 | Now I need to fix two things: 1. Remove the old `const role = roleFromSource(source);` line (role now comes from classification). The `source` variable becomes unused. 2. For terminal PLANNER_RESPONSE with content, we want it as a message.  |
| 3 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:03779c134dd99850052f6111e8e2651e | assistant/54 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"⟦shape adjustment⟧ The excess is not the session token scheme; it is tool JSON being turned into an escaped JSON string inside another JSON envelope. I’m switchin |
| 4 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:d1c2c8e36f7b27bc841784b90ea65a1a | assistant/18 | Now I understand the problem. The independent counter is identifying that the adapters are storing machinery dump rows (empty JSON envelopes) as message rows on the search surface, which violates the documented mapping. The product should o |
| 5 | 0.0161 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/7038 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"> Re `summary.diffs`: yes, that is provider display/reconciliation metadata unless it is emitted as an explicit session event/tool result. It should not become a  |

### decision-memory — decision-memory recall

Query: `Convex limits are the contract store at turn grain indexing separate decision`

Intent: Find the durable architecture rulings that shaped Quasar's data model.

#### lexical

Status: ok (200, 12ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 28.7653 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:6db641804f280f75db59fd32a76d798f | assistant/21 | `resolveProjectIdentity` already exists in the salvage and does exactly what you described — signal hierarchy: explicit key → normalized git remote → package name → workspace → canonical path fallback. Every adapter already stamps `projectI |
| 2 | 25.7333 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 3 | 25.7333 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:fdb2a39d6facfa76550eb0ff6cf915c8 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 4 | 25.7333 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:3563d2d172780a72ad29870314102a04 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 5 | 25.7333 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:40fa41cd926ec966750638b7ff8419d0 | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |

#### semantic

Status: ok (200, 460ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.1681 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d6600c1c0b0ff3bff680fb629899e9d5 | assistant/4093 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"! another contract layer :: the current row byte budgets do not equal indexed-field budgets. IDs like `session.id`, `event.id`, and `toolCall.id` are accepted as  |
| 2 | -0.1701 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d6600c1c0b0ff3bff680fb629899e9d5 | assistant/4092 | {"type":"agent_message","message":"! another contract layer :: the current row byte budgets do not equal indexed-field budgets. IDs like `session.id`, `event.id`, and `toolCall.id` are accepted as arbitrary strings by the Effect/Convex boun |
| 3 | -0.1731 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:7ff05be9c6c8077aed750a1bc6fb5e8c | assistant/5 | {"type":"agent_message","message":"= review target :: scoped data/index contract only \|- contract checked :: row grain & columns & FTS/vector indexes & hybrid RRFReranker & Gemini 1536 enforcement","phase":"commentary","memory_citation":nul |
| 4 | -0.1772 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:7ff05be9c6c8077aed750a1bc6fb5e8c | assistant/6 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"= review target :: scoped data/index contract only \|- contract checked :: row grain & columns & FTS/vector indexes & hybrid RRFReranker & Gemini 1536 enforcement" |
| 5 | -0.1795 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:a8af0515476515463acd13a35bd68e54 | assistant/1223 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"AS: While those run: the current architecture answer is becoming sharper. Convex is fine for the session intelligence index, but only if the rows are Convex-shape |

#### fusion

Status: ok (200, 79ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d6600c1c0b0ff3bff680fb629899e9d5 | assistant/4093 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"! another contract layer :: the current row byte budgets do not equal indexed-field budgets. IDs like `session.id`, `event.id`, and `toolCall.id` are accepted as  |
| 2 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | claude:machine:76e148fc65f0750b08e057de1f1c3755:6db641804f280f75db59fd32a76d798f | assistant/21 | `resolveProjectIdentity` already exists in the salvage and does exactly what you described — signal hierarchy: explicit key → normalized git remote → package name → workspace → canonical path fallback. Every adapter already stamps `projectI |
| 3 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:d6600c1c0b0ff3bff680fb629899e9d5 | assistant/4092 | {"type":"agent_message","message":"! another contract layer :: the current row byte budgets do not equal indexed-field budgets. IDs like `session.id`, `event.id`, and `toolCall.id` are accepted as arbitrary strings by the Effect/Convex boun |
| 4 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:b8dd4809f496a42226ecb6b36be9ac0c | user/0 | {"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions for /Users/guilhermecastro/Projects/quasar <INSTRUCTIONS> <!-- BEGIN: agent-shorthand --> --- description: Use Agent Shorthand as the default s |
| 5 | 0.0161 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:7ff05be9c6c8077aed750a1bc6fb5e8c | assistant/5 | {"type":"agent_message","message":"= review target :: scoped data/index contract only \|- contract checked :: row grain & columns & FTS/vector indexes & hybrid RRFReranker & Gemini 1536 enforcement","phase":"commentary","memory_citation":nul |

### operations — operations proof

Query: `Mac mini Tailscale IP Docker local server full corpus ingest proof`

Intent: Find operational proof sessions about Mac mini deployment and full ingest readiness.

#### lexical

Status: ok (200, 10ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 36.8232 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/62 | {"type":"agent_message","message":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-mini.<tailnet-suffix>` - Tailscale version: |
| 2 | 36.7656 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/63 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-m |
| 3 | 35.9617 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/129 | {"type":"agent_message","message":"**Goal Shape** Use one stable device tag for the Mac mini: ```text tag:mac-mini-server ``` Use Tailscale Services for each app: ```text svc:tower -> https://tower.<tailnet-suffix>/ svc:metrics -> https:// |
| 4 | 35.9310 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/130 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Goal Shape** Use one stable device tag for the Mac mini: ```text tag:mac-mini-server ``` Use Tailscale Services for each app: ```text svc:tower -> https://tower |
| 5 | 35.0777 | path:machine:76e148fc65f0750b08e057de1f1c3755:bb1bdc4e6bd274f5985e0ca0086b42a7 | codex:machine:76e148fc65f0750b08e057de1f1c3755:ca77fa0c6d132123c13ac7d681ccbab5 | assistant/453 | {"type":"agent_message","message":"Deleted the verbose file. Relevant shared config fact from `~/Projects/system-setup/system-config.json`: - Both machines use the same Continuwuity runtime shape: `~/.matrix/continuwuity/{.env,compose.yml,d |

#### semantic

Status: ok (200, 583ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | -0.1379 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:20a34f88adfea87f1d7661aa18598d99 | user/1 | {"type":"message","role":"user","content":[{"type":"input_text","text":"let's instantiate a local deployment of telechy-control in this machine / mac mini and expose it to our tailscale"}]} |
| 2 | -0.1419 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/31 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"The local machine is `mac-mini` at `<mac-mini-tailscale-ip>` on Tailscale `1.96.5`, which is new enough for Tailscale Services. The repo is clean, so any findings won’t be  |
| 3 | -0.1432 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:20a34f88adfea87f1d7661aa18598d99 | user/2 | {"type":"user_message","message":"let's instantiate a local deployment of telechy-control in this machine / mac mini and expose it to our tailscale"} |
| 4 | -0.1458 | path:machine:76e148fc65f0750b08e057de1f1c3755:6def48b1f9daae76a2e07517e247773c | codex:machine:76e148fc65f0750b08e057de1f1c3755:f5cad0c1da923d9a27a2189b69244334 | assistant/1114 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"= live target :: local Convex on `127.0.0.1:3217` is responding and action secret exists. I’m forcing the CLI proof through loopback so this verifies the server a |
| 5 | -0.1483 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/30 | {"type":"agent_message","message":"The local machine is `mac-mini` at `<mac-mini-tailscale-ip>` on Tailscale `1.96.5`, which is new enough for Tailscale Services. The repo is clean, so any findings won’t be mixed with uncommitted local work.","phase" |

#### fusion

Status: ok (200, 74ms)

| rank | score | project | session | role/seq | snippet |
| ---: | ---: | --- | --- | --- | --- |
| 1 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:20a34f88adfea87f1d7661aa18598d99 | user/1 | {"type":"message","role":"user","content":[{"type":"input_text","text":"let's instantiate a local deployment of telechy-control in this machine / mac mini and expose it to our tailscale"}]} |
| 2 | 0.0167 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/62 | {"type":"agent_message","message":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-mini.<tailnet-suffix>` - Tailscale version: |
| 3 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/31 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"The local machine is `mac-mini` at `<mac-mini-tailscale-ip>` on Tailscale `1.96.5`, which is new enough for Tailscale Services. The repo is clean, so any findings won’t be  |
| 4 | 0.0164 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:90087fe28ea35c350906e2f8ec3b83fb | assistant/63 | {"type":"message","role":"assistant","content":[{"type":"output_text","text":"**Scans Complete** I did not change config. Current state: - Mac mini Tailnet IP: `<mac-mini-tailscale-ip>` - Tailnet suffix: `<tailnet-suffix>` - Current MagicDNS: `mac-m |
| 5 | 0.0161 | path:machine:76e148fc65f0750b08e057de1f1c3755:388780f63d66c91f72df3aa8ebfb2121 | codex:machine:76e148fc65f0750b08e057de1f1c3755:20a34f88adfea87f1d7661aa18598d99 | user/2 | {"type":"user_message","message":"let's instantiate a local deployment of telechy-control in this machine / mac mini and expose it to our tailscale"} |

## Interpretation checklist

- Mark Nomic as acceptable only if it retrieves the same session families or better on project/session, code/debug, JSON-ish transcript, and decision-memory queries.
- Prefer fusion for operator use when lexical/code snippets matter; semantic-only is a recall aid, not the sole retrieval surface.
- Re-run this proof with both `gemini=<url>` and `nomic=<url>` profiles before changing the production default for a larger estate.

