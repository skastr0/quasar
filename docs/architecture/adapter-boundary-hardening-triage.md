# Adapter boundary hardening triage (TS-AD-04 / TS-LD-09)

Reference-arch slice for visible decode + typed error channels at the CLI
ingest boundary. Dispositions:

| tag | meaning |
|---|---|
| **(a)** | Route through visible Schema decode / named diagnostic channel |
| **(b)** | Type the error channel (TaggedError or named diagnostic; no silent fallback) |
| **(c)** | Document as deliberate pre-decode classification / optional-field peek; do not rewrite |

Corpus receipt to preserve: zero error sessions on the live estate today —
this work is future-drift visibility, not present brokenness.

## Two-layer diagnosis

1. **Record layer** (per-harness `classify*` / `*DiscriminatorOf` / schema
   dispatch) — fail-closed by design. Every on-disk record routes to exactly
   one schema decode; unmodeled/failed decode → named drop, no unknown
   pass-through. Pulsar flags the pre-decode `typeof` discriminator peek; that
   peek is one line above the decode and is required.
2. **File/field layer** (`packages/cli/src/adapters/common.ts`) — was fail-open.
   Corrupt JSONL lines, unreadable files, and wrong-shape field peeks could
   vanish without a named diagnostic. This layer is sealed here.

---

## TS-AD-04-boundary-parser-coverage

| site | disposition | rationale |
|---|---|---|
| `rolesFromInvokeToolCall` — `antigravity-schema.ts` | **(c)** | Pre-decode role projection on an already-classified invoke tool call; schema owns the boundary. |
| `claudeMessageKind` — `claude-schema.ts` | **(c)** | Pre-decode kind discriminator for declarative dispatch; decode is `decodeOrDrop` one step below. |
| `classifyClaudeRecord` — `claude-schema.ts` | **(c)** | Fail-closed declarative dispatch (record layer). `typeof` peek is intentional pre-decode. Do not rewrite. |
| `codexDiscriminatorOf` — `codex-schema.ts` | **(c)** | Same as above for Codex. |
| `classifyCodexRecord` — `codex-schema.ts` | **(c)** | Same as above for Codex. |
| `numberValue` — `common.ts` | **(a)** | Visible `Schema.Number` decode + finiteness gate. Optional field peek: wrong type → `undefined`, not a corruption diagnostic. |
| `stringValue` — `common.ts` | **(a)** | Visible `Schema.String` decode. Optional field peek after a record is in hand. |
| `scopedId` — `common.ts` | **(c)** | Internal id constructor over already-typed adapter values; not an external boundary. |
| `jsonBlock` — `common.ts` | **(c)** | Content-block constructor for already-projected values; not an ingest parser. |
| `contentBlocksFromNative` — `common.ts` | **(c)** | Projection helper over redacted native values after session build; record layer already filtered garbage. |
| `edgeIdFor` — `common.ts` | **(c)** | Internal id constructor; not an external boundary. |
| `recordFrom` — `common.ts` | **(b)** | Wrong shape → `undefined` (never `{}`). Optional diagnostics sink emits `record.wrong_shape` / `record.decode_failed`. |
| `parseJsonString` — `common.ts` | **(b)** | Dual-format fields: non-JSON string returns original; diagnostics sink emits `json.string.invalid` when supplied. |

---

## TS-LD-09-error-channel-opacity

| site | disposition | rationale |
|---|---|---|
| `readJsonFile` — `common.ts` | **(b)** | Failure kinds distinguished: `missing` (ENOENT), `unreadable` (permission/IO), `invalid_json` (parse). Named diagnostic required when sink supplied; return remains `undefined`. |
| `readJsonLines` — `common.ts` | **(b)** | Per-line parse failures emit named diagnostic with `file:line`; line dropped, file continues. File-open failures: `missing` vs `unreadable`. |
| `compactText` — `common.ts` | **(c)** | `JSON.stringify` catch is display-only projection of already-redacted values; cannot invent product text. Not an ingest acceptance path. |
| `loadMachineIdentity` — `machine.ts` | **out of estate** | Outside adapter packages; residual for a later slice if needed. |
| `loadManifest` — `ingest.ts` | **out of estate** | Outside adapter packages. |
| `loadNativeSimsimd` — `vectorKernel.ts` | **out of estate** | Server package; forbidden this slice. |
| `postMappedSession` — `ingest.ts` | **out of estate** | Outside adapter packages. |
| `readWorkdirFromConversationDb` — `antigravity.ts` | **(c)** | Best-effort sqlite sidecar probe for project path; failure means "no path", not a session accept. Session stream still runs. |
| `buildLineageMap` — `antigravity.ts` | **(c)** | Lineage enrichment; primary transcript path has its own diagnostics. |
| `streamAntigravity` — `antigravity.ts` | **(c)** | Stream catch surfaces as adapter diagnostic status; not a silent empty result. |
| `visit` — `codex.ts` | **(c)** | Walk skip on unreadable nested paths; primary rollout file path is diagnostic-gated. |
| Grok subagent `meta.json` read — `grok.ts` | **(b)** | Was sink-less `readJsonFile`; now threads `grok.subagent_manifest.invalid_json` into the stream diagnostic channel. |

---

## Sealed file/field contract (`common.ts`)

```
readJsonLines  |> named diagnostic (file + line) on corrupt line; never silent when sink set
readJsonFile   |> missing | unreadable | invalid_json distinguished in name/message
recordFrom     |> Record | undefined  (never {})
stringValue    |> Schema.String  |> empty/wrong → undefined
numberValue    |> Schema.Number + finite  |> wrong → undefined
parseJsonString|> JSON.parse; fail → original string + optional named diagnostic
```

Diagnostics use the same `{ name, message }` shape as `DecodeDiagnostic` and
flow through each adapter's existing `AdapterStreamItem` `diagnostic` arm.

## Residual

- CLI-core / server sites listed as **out of estate** stay for follow-up outside
  this adapter slice (machine identity, ingest manifest, vector kernel).
- Record-layer classifiers remain **(c)** permanently unless the schema model
  itself changes — rewriting them to "appease" AD-04 is the anti-pattern.
- Optional field peeks (`stringValue` / `numberValue`) remain silent on wrong
  type by design: absence and mistype are the same product outcome on
  heterogeneous native records after the record layer has accepted the parent.
- Goldens from the adapter safety-net commit stay byte-stable; hostile suite
  covers line/file corruptions for all seven adapters.
- **QSR-259 function-size AC residual (honest, not chased):** the large adapter
  stream/session assemblers (`buildAgentSession` kimi, `streamCodex`,
  `buildAntigravitySession` / `streamAntigravity`, `streamOpenCode`) remain
  above ~80 LOC. Move 2 extracted proven source clones (`adapters/source.ts`);
  Move 3 closed Claude usage fail-open and will continue per-adapter
  decode-to-domain shrinks in later slices — LOC bars fall out of that work,
  never from cosmetic splits that risk golden breaks. Server `chunksOf` /
  `chunked` clones stay out of this glyph estate.
