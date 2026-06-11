# Quasar v2 — Canonical Greenfield Plan

Date: 2026-06-10
Status: handoff document — buildable cold
Provenance: synthesized from a 14-agent forensic audit (tower glyph history QSR-001..028,
git forensics over 96 commits, core/Convex/CLI code audits, empirical byte measurement on
real session files, product-fit consumption matrix), a 3-judge salvageability panel, and
two competing architecture drafts merged by a synthesis judge.

## Panel verdict summary

All three judges (salvage-lens, greenfield-lens, neutral) independently concluded:

- The product is viable. 387MB of useful text serving lexical+semantic search and bounded
  reads is a small, achievable system.
- Verdict: hybrid salvage (2 judges) / salvage-in-place (1 judge) — converging on the same
  substance: greenfield the data contract, storage shape, and Convex schema; keep the
  ledger, envelope protocol discipline, embedding outbox, data-bearing adapters, and the
  search/read surface (~60-70% of product LOC is verified keeper-grade).
- Distance to a working full-corpus ingest + search: ~6-10 focused glyphs, 3-5 days at the
  demonstrated pace.
- The 1.5x wire-amplification gate invented by QSR-022 is mathematically unreachable in the
  current 7-type row-granular taxonomy (id floor ~1.78x) and its denominator excludes tool
  I/O — the remaining failure is one storage-shape decision plus a spec contradiction, not
  rot. Continuing the QSR-024..028 compaction chain cannot pass and is gutting product
  fidelity (256-byte tool clamps) to chase the ratio.
- A third full reset is disproven by history: the 06-09 reset was already a clean room with
  zero file-path reuse and re-derived the same bloat within hours, because the shape was
  decided before it was measured. The fix is process (byte floor computed before any
  storage code), not folder freshness. The plan below works equally in a new folder (copy
  the keeper modules) or in place (delete the killed modules).

---

# QUASAR v2 — CANONICAL GREENFIELD PLAN (handoff)

= status :: this is a greenfield of the *data contract, storage shape, and Convex schema only*. All three panels (salvage / greenfield / neutral) converge that ~60-70% of the repo is verified keeper-grade and that the prior clean-room (commit 7cd35e7, -17,039 LOC, zero path reuse) re-derived the same bloat within hours because the **shape was decided before it was measured**. So the build is greenfield-in-spirit, reuse-heavy in fact: kill the 9-type taxonomy / composite ids / child-graph schema; keep the ledger, envelope protocol, embedding outbox, adapter parsing. The one non-negotiable process rule: **glyph 1 computes the byte floor on paper before any storage code lands.**

= spine ruling :: **Plan B (durability-first) is the spine.** It makes first-class the exact four walls that burned the project twice — daily incremental sync, file-change reconciliation, interrupted runs, contract evolution — and it uses message granularity, the correct unit for both embedding quality and append-only sync. Plan A is leaner at rest but its 64 KiB chunks are the wrong embedding unit (they exceed the 8,191-token embedder window and would silently truncate) and its 550-650 MB local full-fidelity mirror duplicates the source files to serve no current endpoint.

## Disagreement ledger (rulings)

1. **Record granularity: A chunk-embedded events vs B per-message docs.** RULING: B. 64 KiB chunks truncate under embedders and force whole-chunk rewrites; per-message docs are pure inserts on append and give precise hits. Cost (+~16 MB wire, larger vector budget) is accepted.
2. **Local store: A full-fidelity SQLite mirror vs B reconciliation-only ledger.** RULING: B (<1 MB ledger). Source files are already the fidelity store; rebuild re-parses them. GRAFT A's "Convex is disposable" framing as the FTS5 exit-hatch (see §8).
3. **Idempotency: A per-record hash-skip vs B key-based always-write.** RULING: B. The hash-skip-before-refresh path *is* the QSR-027 stale-search-doc bug; always-write makes the class unrepresentable.
4. **Ordering: A fail-closed-parent vs B stub-session out-of-order.** RULING: B. Stub rows make retries/parallel/resume safe.
5. **Project identity: A denormalize+restamp children vs B immutable pk + read-time alias table.** RULING: B. Immutable keys delete the entire denormalized-staleness class by construction, not by property test.
6. **Denominator: A 387.6 MB vs B 398 MB.** RULING: **D = 387 MB** (the evidence digest). B's 398 MB assumed ~100 MB tool I/O capture; ~3% high — corrected below.
7. **GRAFT from A:** per-message 64 KiB text cap with truncation marker (keeps every doc << 1 MiB); thorough Convex-limit arithmetic; the disposable-Convex exit hatch.

## 1. Storage topology

= three tiers, one job each
  | provider source files (~1.64 GB) :: the fidelity store. Never copied, never re-hosted. `sessions.src` points back; deep raw forensics = local re-parse (no served endpoint needs it today).
  | local SQLite ledger (`~/.quasar/ledger.db`) :: reconciliation state ONLY — fingerprints, prefix/content hashes, ack high-water marks. Zero payload columns. **~2.2 k rows, < 1 MB** (vs the 1.26 M-row / 300-400 MB recordStates mirror that is killed).
  | Convex :: serving store only — what an endpoint reads, nothing else.

= Convex contents + honest at-rest bytes (today's corpus)
  | sessions ~1.6 k docs ~0.6 MB | messages ~453 k docs ~341 MB | toolCalls ~84 k docs ~110 MB | projects + outbox/cache/readiness ~10 MB
  → documents ≈ 462 MB; + per-doc system/index overhead (539 k docs × ~120 B) ≈ 65 MB; + search index (~1× indexed text) ≈ 387 MB
  → **lexical at rest ≈ 0.9 GB (~2.3× useful text)**; + opt-in vectors (~150 k units × 6 KB) ≈ 0.9 GB → **~1.8 GB with semantic**
  ! correction to BOTH plans :: A's "≤1.7× useful" and B's "≤1.2× wire" storage gates are arithmetically impossible — a Convex search index roughly doubles indexed-text storage. At rest is ~2.3× useful lexical, ~4.6× with vectors. This is fine: 1.8 GB is **4% of Convex Pro's 50 GiB**. Capacity is a non-issue; **cost is the only constraint and it is $25/mo from day one** (the 42 GB anti-benchmark becomes <2 GB).

= deleted concepts :: recordStates server ledger-mirror, searchDocuments copy table + lexicalText byte-duplicate, content_block rows, edge rows, usage rows (rolled into session doc), machines/agentDefinitions tables, per-row tombstones, composite ids.

|- Convex limits :: msg doc ≤ 64 KiB text << 1 MiB cap; read page ≤ 1 MiB; ingest envelope ≤ 800 records → ≤~2.4 k writes << 8,192 write limit; full rebuild ~539 k writes << 1 M calls/mo.

## 2. Wire contract + computed amplification

= protocol :: `quasar-sync/v2`; envelope `{v:2, m, rev, ses[], msg[], tc[], del[], trim[]}`; **≤ 512 KiB** (content-length fast-fail, reuse v1 http.ts cap), **≤ 800 records**. Typed arrays remove per-record `"type"` wrappers; machine `m` sent once per envelope, never per record.

= id scheme (B)
  | session token `s` :: base32(80-bit BLAKE2b of machineId|provider|nativeSessionId) = **16 chars**; collision over 1e5 sessions ≈ 4e-15; machineId in preimage ⇒ multi-machine safe, zero per-record machine bytes.
  | message identity (s,q) — q = event seq; tool identity (s,c) — c = call seq; **0 extra id bytes**, idempotency = upsert by key, last-write-wins.
  | project key `p` :: base32(60-bit hash of canonical path) = 12 chars, **immutable by construction**. Aliasing/grouping is a read-time table, never a stored-row rewrite — deletes the QSR-027 class.

$ record shapes (measured-style)
```
ses ~400B  {s, p, pv, a?, t?, ts0, ts1, src, n(eventCount), u:{model:{i,o,c}}}
msg ~95B+x {s, q, t, r:"u|a|s|t", k:"m|r|x|e", pv:provider, x:text≤64KiB+trunc-marker, tc?}
            -- tool events carry NO payload in x (gloss only); payload lives once in tc
tc ~116B+p {s, c, q, n(name), st?, t0?, t1?, x:"input ⸻ output",
            caps 16KiB in / 32KiB out, truncation marker {bytes,hash,preview}}
del 26B    {s}            -- session tombstone
trim 36B   {s, q:maxSeq}  -- shrunk-session reconcile
```
= text policy (FROZEN at contract freeze, product-derived, never moved to chase the gate) :: per-message 64 KiB cap (GRAFT from A); tool I/O rendered **once** in tc at full 16/32 KiB fidelity, searchable. This explicitly reverses QSR-028's 256 B clamp (Goodhart: it shrank useful text as fast as wire) and kills the contentText/payload double-carry.

= frozen denominator **D = 387 MB** :: deduped message text + tool-payload text counted once each (the evidence digest). Any fidelity CUT shrinks D ⇒ fails the gate by definition; higher caps capturing more real payload ADD to D (genuine product value), they do not inflate the ratio.

$ amplification (today's corpus)
```
useful text (msg text + tool payload, once each)  387.0 MB
msg frames    453k × 95B                            43.0 MB
tc frames      84k × 116B                            9.7 MB
ses docs      1.6k × 400B                             0.6 MB
envelope framing                                      0.3 MB
total wire                                          440.6 MB
amplification  440.6 / 387.0                       = 1.14x   (gate 1.5x; 140MB headroom)
```
^ floor proof :: per-record overhead ~95-116 B ≤ the 154 B/record budget the 1.5× gate implies at this record count; vs v1's 250-460 B composite ids against that same budget (the structural cause of 2.733×). 2×-overhead worst case → 1.27×. **Passing is a property of the shape**, matching the audits' 1.14-1.4× floor.

## 3. CLI architecture

= modules :: `discover` (roots→files) | `adapters/*` (file→event streams) | `hashchain` (rolling prefix hash) | `ledger` (sqlite) | `pack` (envelope builder, **running byte counter — no per-append re-stringify**, fixes the O(k²) bug at records.ts:746-779) | `send` (HTTP + backpressure + body-digest verify) | `report` (byte-attribution harness, carried) | `run` (orchestrator).

$ ledger schema — only what reconciliation needs
```sql
meta(k PK, v);
files(path PK, provider, size, mtime_ms, adapter_rev, status, scanned_at);   -- ~600
sessions(token PK, file_path, native_id, acked_seq, prefix_hash,
         content_hash, acked_hash, pending_delete, updated_at);              -- ~1.6k
```
  = no per-record rows :: idempotent (s,q) upserts make per-record send-state unnecessary; resending one session on a rare edit is cheaper than 1.26 M ledger rows.

= streaming pipeline (per file) :: ledger fingerprint check **before parse** (mandatory; fixes parse-before-skip RSS) → adapter streams events one at a time → normalize + clamp → fold into rolling prefix hash → append to envelope buffer → flush at 512 KiB → digest-verified ack → advance `acked_seq`. Ledger writes batched per file, cached statements (fixes per-record BEGIN IMMEDIATE).
  change classification :: fingerprint unchanged → skip, zero parse | prefix-hash@acked_seq matches → **pure append, send only q>acked_seq** (the daily case, O(delta)) | prefix mismatch → full session resend + trim | file missing → del, pending_delete until acked.

|- memory bound :: resident = 1 clamped event (≤32 KiB) + envelope buffer (512 KiB) + hash state + handles = O(1). **RSS ≤ 256 MB on the real largest provider file through the real adapter path. Tests ban synthetic stream stubs** (the 768 MB-stub lie cannot recur).
|- resume :: `acked_seq` advances only on digest-verified ack; kill -9 anywhere → rerun resends an idempotent tail → byte-identical server state.
|- rebuild :: `quasar sync --rebuild` = paginated admin wipe + re-parse source files (GRAFT A's disposable-Convex idea, B's source-of-truth) — the universal staleness cure and the FTS5 exit-hatch enabler.

## 4. Convex architecture

$ tables + indexes (counts, not combinatorics — vs v1's 12-15)
```
sessions  by_token, by_p_ts1, by_ts1
messages  by_s_q;  searchIndex(x, filterFields:[p, r, k])
toolCalls by_s_c, by_p_n;  searchIndex(x, filterFields:[p, n])
projects  by_pk, by_alias
+ carried verbatim: embeddingOutbox / Controls / Readiness
```
  new filter index only when a shipped endpoint needs it (consumption-matrix CI test enforces).

= ingest endpoint :: `POST /sync` — single write path. Fail-closed schema decode, 512 KiB pre-parse cap (reuse http.ts:52-125). Apply: ses upsert by token → msg/tc upsert by (s,q)/(s,c) with a **per-envelope memoized session-lookup Map** (fixes 200 identical reads) → trims → dels.
  **out-of-order tolerant** :: msg before ses creates a stub session row, filled when ses arrives — envelopes valid in any order (deletes v1's fail-closed-parent poison). **No unchanged-hash skip path exists** — idempotency is key-based, so QSR-027 is unrepresentable.
  acks :: `{applied per type, deleted, bodyDigest(BLAKE2), contractRev, backpressureMs}` — fixes v1 counts-only blindness + adds corruption detection (GRAFT B wall 2).
  cascade delete :: internal mutation with **cursor continuation**, regression test on a >5 k-row session (the 500-cap-no-continuation family).

= reads :: searchText (multi-eq index filters; alias fan-out = few canonical-key queries merged), searchSemantic + RRF fusion (carried), sessionRead (messages by_s_q paginated ≤1 MiB/page), toolCalls list/read, projects browse.

= embedding/RAG (wall paid in full — it burned before) :: msg-insert length-gated policy → outbox row → leased drain w/ backoff + dead-letter → RAG write → readiness bump. Embed at message granularity (sub-chunk messages >8 KiB); vectors carry a **separate budget line, excluded from the amplification gate** (feature, not overhead). Carried verbatim: quasarRagSync.ts, quasarEmbeddingReadiness.ts, quasar.ts:243-472, HMAC cache keys quasarSearchDocuments.ts:304-350.

## 5. Adapter strategy

= build only data-bearing providers :: **claude, codex, opencode** first (~94% of ~1,565 sessions), then **hermes** (~67-74), then **grok** (10) optional. **The 6 zero-data adapters (amp, pi, kimi, droid, antigravity, cursor; ~1,654 LOC) are never ported** until data + a consuming endpoint exist.
$ interface
```typescript
interface Adapter {
  id: ProviderId
  rev: number                              // parse-contract revision, in the fingerprint
  discover(roots): AsyncIterable<SourceFile>
  sessions(file): AsyncIterable<{
    nativeId; cheapFingerprint?;           // multi-session stores: skip before row-stream
    meta(): SessionMeta
    events(): AsyncIterable<NormEvent>     // one at a time, never materialized
  }>
}
```
! wall 3 — adapter_rev :: provider formats drift; `rev` participates in the fingerprint, so bumping it dirties exactly that provider's files — bounded reprocess, no manual resets. (Plan A has no equivalent; this is a B graft kept.)
= quirk quarantine :: ALL provider key knowledge (content shapes, callID variants, drop-lists as provider-scoped allowlists with per-key drop counters surfaced in the report) lives inside the adapter; `common` owns only NormEvent types + truncation markers + binary-detection. No generic `state`/`raw`/`cache` sniffing in common; every dropped byte counted.
|- admission :: existing data on this machine AND a consuming query AND all gates green.

## 6. Reuse map

+ copy nearly verbatim :: embedding outbox/drain/dead-letter + readiness aggregates + RAG sync (quasar.ts:243-472, quasarRagSync.ts, quasarEmbeddingReadiness.ts); HMAC cache keys (quasarSearchDocuments.ts:304-350); HTTP auth + content-length fast-fail + no-client-embeddings (http.ts:52-125,335-344); compactString binary heuristic + truncation/payload markers (packages/core/src/adapters/common.ts:144-209); codex native streaming loop (codex.ts:586-711) as the parse template; report.ts field-attribution byte harness; convex-test rollback + kill -9 resume patterns (ingest-runner.test.ts:161-396); ledger.test.ts ack-verification discipline.
+ mine for knowledge, rewrite :: claude/codex/opencode/hermes parsing tables (re-emit through the new streaming interface — extraction is correct, materialization is not); ledger.ts fingerprint-skip + hash-verified-ack semantics; record-stream unit/fingerprint contract (shouldProcessUnit, UnitFingerprint, unitEnd/rootScanned); reset report + byte-budget doc as the written boundary principles.
+ never open again :: quasarRecordIngest.ts child arms; records.ts clamp/dedup/legacy-reject machinery; bridgeRecordStream / sessionToRecords; edges/usage/contentBlocks/recordStates/tombstones schema; searchDocuments dual-text; the ROWID/`String.fromCharCode(82,79,87,73,68)` obfuscation + banned-vocabulary test that forced it; the 6 zero-data adapters; anything pre-reset.

## 7. Glyph decomposition (gates at glyph 1 AND 4; review verdict blocks dependents; no new surface while any gate is red)

1. **Glyph 1 contract freeze + byte-floor proof** — contract doc + frozen D=387 MB definition + ~200-LOC harness over real 5 MB claude / codex / opencode files; validate 16/32 KiB tool caps cover >95% of real payloads. **Gate: sample A ≤ 1.3×; per-record overhead ≤ 116 B pinned on serialized bytes; runs <60 s in CI.**
2. **Glyph 2 claude streaming adapter + memory gate** — events() one-at-a-time off real files into the ledger; `quasar local read` renders a transcript. **Gate: RSS ≤ 256 MB on the largest real claude file via the real path (no stubs); predicate-before-parse pinned; byte-exact text round-trip.**
3. **Glyph 3 Convex core + /sync** — 4 tables, key-based upserts, stub-session, trims, cursor-continuation cascade. **Gate: replayed envelope ⇒ byte-identical state (convex-test); out-of-order envelopes converge; >5 k-row cascade completes; identity drill — re-alias a project ⇒ zero stale filter results.**
4. **Glyph 4 ledger + runner — FULL BYTE/MEMORY/RESUME GATE** — full claude+codex+opencode corpus dry run. **Gate: A ≤ 1.5× vs frozen D; RSS ≤ 300 MB; runtime ≤ 5 min; kill -9 mid-send converges to identical state; append fast-path sends only the tail.**
5. **Glyph 5 PRODUCT PROOF — search e2e** — live dev ingest + search endpoint + CLI; consumption-matrix test (every stored field ↔ a serving endpoint; unread fields fail build). **Gate: a real query returns real ingested content from all 3 providers with snippets BEFORE any further adapter or optimization lands; p50 < 1 s.**
6. **Glyph 6 full-corpus live ingest + reconciliation proof** — all built providers to real deployment. **Gate: Convex stored bytes ≤ 1.0 GB lexical; file-delete → cascade verified; no-change rerun ≤ 60 s and ≤ 1% of corpus wire; $/mo projection documented.**
7. **Glyph 7 read surface** — sessions list/read, project browse, tool-call list/order + CLI. **Gate: every response field traces to a stored field.**
8. **Glyph 8 embeddings + fusion** — port outbox; semantic + RRF; vector budget reported separately. **Gate: readiness aggregates honest; fusion beats lexical on 5 pinned queries.**
9. **Glyph 9 MCP + thin dashboard** — MCP tools wrap CLI, dashboard wraps existing HTTP, no new tables. **Gate: MCP search + session read from a second agent.**
10. **Glyph 10 hermes (+grok) + schema-evolution drill** — admitted only with all gates green; bump claude `adapter_rev` with a synthetic format change ⇒ exactly that provider reprocesses; old-CLI/new-server contractRev negotiation tested. **Gate: Glyph 4 + Glyph 6 re-pass.**
11. **Glyph 11 consumption audit** — automated table/field→handler map fails CI on dead or hash-only-served fields; ops doc (cron sync, rebuild runbook).

## 8. Kill criteria

|- Glyph 1 :: sample floor > 1.4× → the shape is wrong again; redesign before any storage code, no patching.
|- Glyph 4 :: A > 1.5× vs frozen D after one permitted redesign, OR anyone proposes shrinking D to pass → abandon (floor > gate is structural, not tunable — the v1 lesson).
|- RSS :: > 512 MB on any real provider path after one fix attempt → shape failure, not a bug.
|- Convex specifically :: billed storage > 3× wire bytes OR cost > $25/mo at today's corpus OR search p50 > 2 s after one granularity adjustment → **swap backend to local FTS5 + sqlite-vec behind the same CLI/MCP surface** (the disposability bet pays out as the exit hatch; ledger, adapters, contract survive intact).
|- reconciliation wall :: no-change daily rerun > 5 min or resends > 5% of corpus wire → the wall this plan exists to hold has failed.
|- identity closure :: unfixable without rewriting child rows → the immutable-pk premise broke — abandon before patching.
|- oscillation freeze :: any metric spawning > 2 sequential fix glyphs, or the same files reworked in 3 consecutive commits → mandatory written shape-decision pause before the next commit (directly counters the observed 3-minute-planning-burst / 44%-rework signature).
|- product deadline :: Glyph 5 (search over the full corpus) not green within 5 working days of Glyph 1 → re-scope to claude+codex only and ship before widening.

= one-line thesis :: 387 MB of useful text serving lexical+semantic search and bounded read is a small, achievable system; v2 fails only if the shape is decided before glyph 1 measures it.

---

# Appendix: Lessons Learned (extracted from the full audit)

work-done

## (a) Named anti-patterns

! 1 unit of work inversion :: transport/processing unit chosen as whole-session blob instead of bounded record
  ^ 105MB OpenCode message row; 42GB ~/.quasar-control; post-reset bridge still materializes whole files 4-5x (readFileSync + NormalizedSession + sessionToRecords) for every non-codex adapter; parse runs BEFORE the ledger skip predicate → 1.56GiB RSS
  |- guardrail :: unit of work defined by memory bound in the adapter contract; predicate-before-parse mandatory; RSS test must drive real adapter paths, not synthetic stubs (the 768MB stub test passed while reality was 1.56GiB)

! 2 normalized graph as wire contract :: 5NF row-granular taxonomy shipped over the wire to serve a query engine that doesn't exist
  ^ 7 record types, 1.26M records, 3.4x fan-out; fixed id/key/wrapper cost 250-460B/record vs the 154B/record budget the 1.5x gate implies → 2.733x was a mathematical property of the contract, not tuning
  |- guardrail :: wire carries consumption-shaped documents (session doc + embedded events); compute the byte floor of any contract BEFORE freezing it; floor > gate ⇒ reject the shape

! 3 identity outweighs payload :: id machinery is the largest byte category
  ^ `provider:kind:machine:<32hex>:<32hex>` composite ids of 90-104B, repeated 2-5x/record = 47.7% of all wire bytes; median content_block = 295B shell, 65% ids, 0% text
  |- guardrail :: id bytes ≤ ~10% of record budget; scope child ids to parent (sequence-as-id), reconstruct global ids server-side

! 4 derived data round trip :: client synthesizes derivable data, ships it, server stores it, read path re-derives it anyway
  ^ defaultEdgesForEvents synthesized 523,771 edges client-side (333MB) re-encoding event.parentEventId; server synthesizedTextBlockFor reconstructs pruned text; usage rows duplicate what a per-session rollup serves
  |- guardrail :: derivable data is computed at point of consumption, never serialized; test = re-derive server-side, assert equality, then forbid the wire type

! 5 defensive layers policing self-inflicted geometry :: validators exist only to manage the contract's own duplication
  ^ clamp binary search, duplicate-text suppression (now dead code), rejectLegacyChildFields rejecting the previous version of its own contract, ~10 serialize passes/record, O(n²) packRecordEnvelopes
  |- guardrail :: any validator that rejects your own prior contract version, or any dedup pass on data you emitted, triggers a shape review, not a patch; one serialization per record per trust boundary

! 6 gate criteria before product criteria :: fidelity sacrificed to pass a ratio whose denominator shrinks with the cuts
  ^ QSR-028 clamped tool payloads to 256B/160-char previews, gutting the stated goal "search over tool-call inputs/outputs"; working-tree measurement: 3.17x persisted because useful text shrank as fast as wire
  |- guardrail :: gate denominator = frozen product-required payload set, fixed at contract freeze; any change reducing served fidelity fails the gate by definition

! 7 store everything serve nothing :: warehouse schema under a search product
  ^ ~70% of stored bytes back no served capability — hash-only fields, 1.26M recordStates mirroring the CLI ledger, lexicalText byte-duplicate of searchText, usage rows with no analytics endpoint, machines/agentDefinitions never read; system stores ~3.5x what the product consumes
  |- guardrail :: consumption matrix before schema — every stored field maps to a serving endpoint or is deleted; subtractive audit per milestone

! 8 hash skip without identity closure :: idempotency keyed on partial content while writes denormalize more than the hash covers
  ^ QSR-027 failure — child hashes parent-invariant + unchanged-skip + parent identity stamped into child rows/search docs → silent staleness; same family: alias repoint capped at 500 rows, no continuation
  |- guardrail :: change-detection hash covers every byte the write denormalizes; property test mutating each parent identity field asserts child refresh

! 9 patching the dying plane :: crisis patches stacked on architecture already known structurally broken
  ^ QSR-008..014: four glyphs in one morning on the blob plane, all abandoned 20h later; Era 2 = 57 commits, 95% fix:, 1,208-line module lived <23h
  |- guardrail :: structural failure signal (42GB state) freezes patch work; one diagnosis glyph with a root-cause shape decision precedes any fix glyph

! 10 measure last development :: byte/memory behavior never measured until the gate
  ^ Era 1/2 "never measured" amplification; first measurement 5.33x (3.5x over target) yet the arc built six more layers before confronting it; 12-13 min dry-runs made the fix loop measurement-bound
  |- guardrail :: budget measured on a real-corpus sample at first vertical slice; fast (<60s) representative sample in CI — the empirical audit got the 47.7%-identity answer from one 5MB file

! 11 provider metadata heuristic classification :: generic key-sniffing in "common" silently destroys semantics
  ^ DROPPED_NATIVE_KEYS includes `"state","raw","cache"` → silent loss for any legitimate tool input; 155-line provider-key-sniffing visitor leaked adapter knowledge into common; per-session-constant rawReference duplicated into 453k event rows and the lexical index
  |- guardrail :: provider knowledge stays in adapters; drop-lists are provider-scoped allowlists; every drop is counted/byte-accounted in the ingest report

! 12 agent swarm thrash :: velocity outruns verification
  ^ 60 commits on 06-09; 9 glyphs authored in 3 minutes; 44% of rebuild commits rework files of the immediately preceding commit; 11-minute prune/unprune oscillation (adadt → ec21760); newest committed work already failed review while being hot-patched uncommitted
  |- guardrail :: review verdict blocks the next dependent glyph; oscillation detector (same files reworked N times → forced design pause); commit only after the boundary decision, not to discover it

! 13 rubber stamp review era :: reviews structurally present, functionally absent, exactly while the doomed plane was built
  ^ reviewing→done in 0-22s (QSR-005/006/007); reviewers timed out without verdicts (QSR-002/012/013); post-reset real reviews immediately caught real bugs (data loss, staleness)
  |- guardrail :: reviewer timeout fails closed; no glyph reaches done without a recorded verdict

! 14 speculative breadth during red gate :: surface area grew while the core gate failed
  ^ 6 zero-data adapters = 1,654 LOC (27% of adapter code, 0 records); npm publish 3 days before architectural viability; 12-15 indexes/table for unused filter permutations
  |- guardrail :: no new surface while a gate is red; adapters require existing data and a consuming endpoint

! 15 vocabulary ban as architecture :: terminology test forced `String.fromCharCode(82,79,87,73,68)` to spell ROWID
  |- guardrail :: enforce architecture with structural tests (e.g., "ledger stores no payload columns"), never substring bans

## (b) Day-one invariants (testable)

|- amplification :: full-corpus dry run envelope bytes ≤ 1.5x a FROZEN denominator (contentText + full tool I/O, fixed at contract freeze); fast sample variant runs in CI <60s
|- per record overhead :: id + keys + wrapper ≤ 100B/record, pinned by a byte-level test against real serialized records
|- bounded memory :: ingest RSS ≤ 300MB on the real largest provider file through the real adapter path (no synthetic stream stubs)
|- identity closure :: for each parent identity field, mutating it and re-ingesting refreshes every dependent row and search doc (or no denormalized copy exists) — property test per field
|- no derivable wire types :: for every record type, attempt server-side derivation from sibling records; derivable ⇒ contract rejects it
|- storage equals consumption :: automated audit maps every table/field to a serving handler; unread or hash-only-served fields fail the build
|- crash resume :: kill -9 mid-ingest, rerun converges to byte-identical server state with zero duplicate writes — the QSR-023 proof exists and is green from the first vertical slice
|- product proof first :: a search query returning real ingested content passes end-to-end before a second adapter or any optimization glyph lands

## (c) Process lessons

= glyph sizing :: one falsifiable claim + its measurement per glyph
  QSR-001 (whole product, "done" in 2h) and QSR-004 (done 33s after creation) were bookkeeping; 9 glyphs authored in 3 minutes is batch planning with zero feedback between units

= gate placement :: the measurement gate goes FIRST, not seventh
  QSR-022 was created after six layers landed; the 5.33x first measurement should have halted the arc — a gate that can only fail after everything is built is a post-mortem; QSR-023 (the only end-to-end product proof) never left backlog while 24/28 glyphs went to ingest

= measurement cadence :: invest in a fast sample harness before the fix loop starts
  the 05:14-08:35 loop was measurement-bound (10-13 min full dry-runs per iteration); field-level byte attribution on one 5MB file would have proven the gate mathematically unreachable before five compaction glyphs were spent shaving it

= review rigor precedes velocity, not the reverse
  the rubber-stamp era built the doomed plane; the moment reviews became real they caught data loss (QSR-025) and staleness (QSR-027) — treat review capacity as the throughput ceiling and pace authoring to it

= reset quality was the one bright spot :: replicate it
  QSR-015 worked because it was destructive (zero file-path reuse), vocabulary-banning at the concept level, and accompanied by a written post-mortem — partial salvage (Era 2 patches) failed; clean conceptual resets with explicit principle docs succeeded


---

# Addendum 2026-06-10: Hosting decision — Convex self-hosted locally

Owner decision (supersedes the cloud assumptions in §1 and §8):

- The Convex backend runs **self-hosted on this machine** (open-source convex-backend,
  launchd-managed, bound locally, served to agents over Tailscale). Consumers are the
  CLI, the Prism plugin, and agent MCP tools. The Next.js dashboard is parked — agents
  are the UI.
- The v2 wire contract (`quasar-sync/v2`) and the schema cut remain **mandatory**:
  Convex functional limits (1MiB/doc, mutation arg/write limits) apply self-hosted too,
  and the 42GB blowup was a *local* Convex backend amplifying at rest. The 512KiB /
  ≤800-record envelopes sit comfortably inside the limits.
- Cost section is void: the constraint is disk (~1-2GB at rest for today's corpus) and
  RSS, not $/mo. The amplification gate stays as a cheap regression check, not a fight.
- Disaster recovery = the disposable-server property: source files remain the fidelity
  store; `quasar sync --rebuild` re-creates the backend from scratch. No backup
  machinery is to be built.
- Glyph-1-equivalent must verify self-hosted parity before anything else: text search
  indexes, vector search, and the RAG/components wiring all working on the self-hosted
  backend, reachable from a second tailnet device.
- The FTS5 + sqlite-vec local stack remains the kill-criteria exit hatch if self-hosted
  Convex disappoints (component incompatibility, search perf, ops burden).


---

# Addendum 2026-06-10 (2): Per-field expectations — breaches are rejected, never absorbed

Owner directive, binding on the contract glyph and every build glyph:

The contract declares a **reasonable expectation for every single field**. Inputs outside
expectation are **contract breaches rejected at the adapter boundary** — never anomalies
to handle robustly. A 100MB "message" is not a large message; it is not a message at all,
and a system that gets anywhere near gracefully carrying one has already failed.

Two tiers per field, frozen in the contract document:

1. **Clamp band** — expected real-world variance, absorbed with deterministic truncation
   markers (e.g. message text ≤64KiB, tool input ≤16KiB / output ≤32KiB).
2. **Absurdity bound** — a small multiple beyond the clamp band, past which the input is
   by definition not the thing the field models. Crossing it means the source row is
   either recognized provider garbage (pruned by provider-scoped name, counted) or a
   quarantined source unit with a loud diagnostic (file, session, field, observed size).
   Breached rows never enter the domain, the wire, or storage. There is no
   truncate-and-carry-on path.

This applies to every field — text sizes, events per session, array lengths, nesting
depth, id lengths, sequence ranges — and is enforced by construction: domain types are
bounded/branded (Effect Schema), so out-of-bound values are unrepresentable, and adapter
field readers are bounded, so detection never materializes the offending blob.

Rationale: era 1 warehoused garbage because the system had no concept of "outside the
domain" — `summary.diffs` was handled instead of rejected. Defensive handling of absurd
inputs is that disease. Memory safety (flat RSS) is a corollary of boundary rejection,
not a goal pursued with handling machinery. Rejections are first-class, visible,
countable output of every ingest run — never silent.
