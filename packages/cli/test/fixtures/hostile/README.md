# Hostile ingest fixtures

Minimal provider-native records that reproduce three live ingest failure classes.
Every record is **structurally faithful** to a shape measured in the local corpus
(field names, enum values, nesting) and **synthetic in every value** (no real
conversation text, no real paths, no real identifiers).

Fixtures are raw data files, matching the `fixtures/goldens/*.json` convention:
read them with `readFileSync(join(import.meta.dir, "fixtures", "hostile", …))`.

Wiring: class 1 is covered by `../../ingest-diagnostic-severity.test.ts`,
class 2 by `../../content-block-source-omitted.test.ts`, and class 3 by
`../../grok-adapter.test.ts`. The descriptions below record the original failures.

Identifiers are chosen to append cleanly onto the fixtures built by
`buildFixtureFor` in `../../adapter-test-harness.ts`:

| provider | fixture session id | primary file |
| --- | --- | --- |
| claude | `aaaa1111-0001-4001-8001-000000000061` | `projects/-fixture-quasar/<sessionId>.jsonl` |
| grok | `01900000-0000-7000-8000-000000000061` | `sessions/<encoded cwd>/<sessionId>/chat_history.jsonl` |

Grok fixtures below target `updates.jsonl`, a sibling of `chat_history.jsonl` that
`buildGrokFixture` does not currently write. A builder consuming them must create
that file in the fixture session directory.

---

## Class 1 — claude unknown attachment subtypes

`classifyAttachment` (`packages/cli/src/adapters/claude-schema.ts:733`) drops any
`attachment.type` absent from `ATTACHMENT_VERDICT` with the named diagnostic
`claude.attachment.unknown_subtype`. That drop is correct. The failure is
downstream: `packages/cli/src/adapters/claude.ts:846-858` stamps
`status: "error"` on every diagnostic, and `ingest.ts:445` promotes an error
diagnostic to whole-session failure.

Shapes differ per subtype, so there is one fixture each. All are `type:"attachment"`
records sharing the same envelope (`uuid`, `parentUuid`, `sessionId`, `cwd`,
`timestamp`, `userType`, `version`, `gitBranch`, `isSidechain`, `entrypoint`, and
optionally `session_id` / `slug`).

| fixture | `attachment` payload keys | observed in local corpus |
| --- | --- | --- |
| `claude-attachment-total-tokens-reminder.jsonl` | `type`, `text` | 1118 records / 13 sessions |
| `claude-attachment-mcp-instructions-delta.jsonl` | `type`, `addedNames[]`, `addedBlocks[]`, `removedNames[]` | 59 records / 49 sessions |
| `claude-attachment-hook-system-message.jsonl` | `type`, `content` (string), `hookEvent`, `hookName`, `toolUseID` | 5 records / 1 session |
| `claude-attachment-hook-additional-context.jsonl` | `type`, `content` (**array** of string), `hookEvent`, `hookName`, `toolUseID` | 11 records / 1 session |
| `claude-attachment-auto-mode.jsonl` | `type`, `autoModeConsentFlow`, `bashFirst`, `bypass`, `steerOnly` | 1 record / 1 session |
| `claude-attachment-mcp-instr.jsonl` | `type` only | **not observed locally** — see note |

`mcp_instructions_delta` carries two live variants (add-delta and remove-delta);
both are in the one file. `hook_system_message` and `hook_additional_context`
share a hook envelope but differ in `content` arity (string vs array) — keep them
separate.

`hook_additional_context` was **not** in the brief but is equally unmodeled and
live locally; it is included so a fix that enumerates subtypes covers it.

**Note on `mcp_instr`:** zero records with this subtype exist in the local claude
corpus, while `mcp_instructions_delta` (22 chars) is common. `mcp_instr` is
9 chars, a plausible truncation of it. The fixture is therefore the degenerate
case — an attachment with only a `type` — and doubles as the "unknown subtype
with no extra fields" input. If a builder introduces diagnostic-message
truncation, this fixture is the regression guard for it.

Expected behaviour after a fix: the named drop still fires, the session still
ingests, and the diagnostic does not carry `status: "error"`.

---

## Class 2 — content blocks of `kind=image` / `kind=file` with no source

`ContentBlock` refines on payload
(`packages/protocol/src/normalized-session.ts:139` for image, `:143` for file):
a block of `kind: "image"` must carry `path` or `uri`, else the whole
`NormalizedSessionV1` decode fails and the session is lost.

Five emitters can produce such a block. Each fixture is the **provider-native
input** that leads to it.

| fixture | emitter | native shape |
| --- | --- | --- |
| `claude-image-block-source-stripped.jsonl` | `claude.ts` ~206 / ~277 → `common.ts` `pushMediaOrFile` | `{type:"image", source:{type:"base64", media_type, data}}` — the projection keeps only `{type:"image"}` because `media_type` lives on `source`, not on the block |
| `claude-file-block-no-path.jsonl` | same, `kind=file` branch | `{type:"file", source:{type:"base64", media_type, data}}` — no `file_path` |
| `claude-image-block-url-source.jsonl` | same emitter, **negative** case | `{type:"image", source:{type:"url", url, media_type}}` — Anthropic DID supply a locator, so the block must be located and must NOT carry the marker |
| `grok-tool-call-update-image-data.jsonl` | `grok.ts` `grokContentProjection` → `common.ts` `pushMediaOrFile` | `updates.jsonl` `sessionUpdate:"tool_call_update"`, `content[0] = {type:"content", content:{type:"image", data, mimeType}}` |
| `pi-image-content-data-mime.jsonl` | `pi.ts:157` `imageBlock` | `{type:"image", data, mimeType}` — the emitter sets `mediaType` and never `path`/`uri` |
| `prime-image-content-data-mime.jsonl` | `prime.ts:161` `imageBlock` | same shape (latent; no live prime failure in the last tick) |
| `cursor-image-block-hex-buffer.json` | `cursor.ts:854-865` | `{type:"image", image:{__type:"Uint8Array", hex}, mimeType, providerOptions}` — note the field is `mimeType`, while the emitter reads `block.mediaType`, so neither `uri` nor `mediaType` is set |
| `amp-image-block-base64-source.json` | `amp.ts:1047-1057` | thread export message with `{type:"image", source:{type:"base64", …}}` — `uri` is set only when `source.url` exists, and there is no `sourcePath` (latent) |

`common.ts` `pushMediaOrFile` (~575-640) is the shared root cause for the claude
and grok fixtures: `path` and `uri` are conditionally spread, so a record that
triggers the image branch with neither locator emits an unsatisfiable block.

**Resolved.** `ContentBlock` now admits an image/file block with no locator if
and only if it carries `sourceOmitted: true`, and every media block in the CLI
is built by the one constructor `mediaContentBlock` (`common.ts`), which derives
the marker from the locators rather than accepting it from a caller. These seven
fixtures are the regression guard: each one fails closed with
`content block kind=image requires path or uri` against the pre-change
refinement, and now round-trips with the marker plus whatever `mediaType` /
`sourceBytes` the provider stated.

The cursor and amp fixtures are message payloads, not files on disk — cursor
messages are stored as sqlite blobs (see `buildCursorFixture` /
`rewriteCursorFixtureUserMessage`), and amp threads arrive from the `amp` CLI
runner (see `amp-adapter.test.ts`'s `fixtureRunner`).

---

## Class 3 — grok unmodeled `sessionUpdate` subtypes

`classifyWithTable` (`packages/cli/src/adapters/grok-schema.ts:743`) names an
unknown `params.update.sessionUpdate` as `grok.record.unknown_type`. `grok.ts`
then aggregates those into a `status: "error"` diagnostic
(`grok.ts:1084-1097`, "Dropped N malformed/unknown grok record(s)"), which
`ingest.ts:445` promotes to session failure.

Three subtypes are live and absent from `UPDATE_TABLE`:

| fixture | `sessionUpdate` | payload keys |
| --- | --- | --- |
| `grok-update-image-compressed.jsonl` | `image_compressed` | `images[]` (`index`, `original_bytes`, `original_height`, `original_width`, `compressed_bytes`, `compressed_height`, `compressed_width`), `message` |
| `grok-update-workflow-updated.jsonl` | `workflow_updated` | `run_id`, `name`, `objective`, `revision`, `status`, `current_phase`, `phases[]`, `agents[]`, `active_agents`, `agent_budget`, `agent_usage_incomplete`, `agents_remaining`, `agents_reserved`, `agents_used`, `elapsed_ms`, `foreground`, `last_event`, `last_event_detail`, `last_event_timestamp`, `result_summary` (terminal records only) |
| `grok-update-image-dropped.jsonl` | `image_dropped` | `notes[]` |

Enum values are reproduced verbatim because they are schema surface, not content:
`status` ∈ `active | complete | blocked`, `last_event` ∈ `workflow_started |
phase_entered | workflow_paused | workflow_resumed | workflow_completed`,
`phases[].state` ∈ `pending | active | done`, `agents[].state` ∈ `done`.
All free-text values (`name`, `objective`, `current_phase`, `phases[].title`,
`agents[].label`, `agents[].phase`, `last_event_detail`, `result_summary`,
`message`, `notes[]`) are synthetic.

`image_compressed` carries a single-image and a multi-image variant; both are in
the one file. `workflow_updated` carries an in-progress record and a terminal one
(the terminal record is the only one with `result_summary`); both are in the one
file.

---

## Privacy

Reproduced from real data: field names, JSON nesting, `type` / `sessionUpdate` /
`status` / `state` / `last_event` enum values, and record envelopes.

Never reproduced: conversation text, file paths from real projects, project or
host names, session or event identifiers, tool-use identifiers, git branches
other than `main`, image bytes. Every base64 payload is a short synthetic string.
Every path is under `/synthetic/`. Every free-text value is prefixed `synthetic`.
