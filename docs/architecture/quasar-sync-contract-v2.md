# Quasar Sync Contract v2

> **HISTORICAL (superseded 2026-06-11).** The owner replaced the stop-line decision
> packet in writing with the
> [data-reality plan](quasar-data-reality-plan-2026-06-11.md): no wire contract, no
> byte gates, Convex-native limits only. This draft was never implemented. Its one
> durable finding — tool events must be single-carried (the draft's msg+tc double-carry
> measured 1.411x) — lives on as a mapping rule in the data-reality plan.

Status: historical — never frozen, never implemented.
Version: `quasar-sync/v2` (retired).

## Product Sentence

Quasar lets agents efficiently ingest local session histories, search them by project,
read chronological sessions, and inspect tool-call inputs, outputs, names, timing, and
status. The sync contract stores only what those serving paths consume.

## Served Queries

- `searchText`: query across message text and tool-call payload text; filters are
  project, role, kind, and tool name.
- `sessionRead`: chronological message page for one session, cursor-paginated under the
  1 MiB read-page budget.
- `toolCalls`: ordered tool-call list/read for one session, including stored input and
  output text at the frozen fidelity caps.
- `projects`: list and alias-aware project lookup.

The frozen denominator derives from those queries: deduped message text plus tool input
and output text, counted once each. Cutting served fidelity shrinks the denominator and
therefore fails the gate by definition. Raising caps adds product value and changes the
denominator only by explicit human shape decision.

## Envelope

`{v:2,m,rev,ses[],msg[],tc[],del[],trim[]}`.

- `v`: literal `2`.
- `m`: machine id, sent once per envelope.
- `rev`: contract revision.
- `ses`: session records.
- `msg`: message records.
- `tc`: tool-call records.
- `del`: session tombstones.
- `trim`: session tail trims after source shrink.

Limits: 512 KiB serialized envelope, 800 records. The server commits in smaller chunks;
the transport contract does not authorize larger mutation batches.

## Record Shapes

Session:

```json
{"s":"16 base32 chars","p":"12 base32 chars","pv":"claude","a":"agent","t":"title","ts0":"started","ts1":"updated","src":"source path","n":123,"u":{"model":"optional"}}
```

Message:

```json
{"s":"session token","q":0,"t":"timestamp","r":"u|a|s|t","k":"m|r|x|e","pv":"provider","x":"message text","tc":0}
```

The failed draft double-carried tool events by allowing a message gloss row plus
a tool-call row for the same provider event. That shape measured `1.411x` on
the Claude sample and is not live authority. The pending decision packet
decides whether tool calls and tool results live only in `tc` records anchored
by `q`, or whether a different written shape replaces it.

Tool call:

```json
{"s":"session token","c":0,"q":0,"n":"tool name","st":"status","t0":"started","t1":"completed","x":"input: ...\noutput: ..."}
```

Delete and trim:

```json
{"s":"session token"}
{"s":"session token","q":123}
```

Forbidden wire types: content blocks, edges, usage rows, artifacts, record-state rows,
search-document copies, machine tables, and agent-definition tables. Edges and usage are
server-derivable; content blocks and artifacts have no served endpoint in v2.

## Identity

- Session token `s`: 16 base32 characters from an 80-bit digest of
  machine id, provider, and native session id.
- Message identity: `(s,q)` where `q` is the event sequence.
- Tool identity: `(s,c)` where `c` is the tool-call sequence.
- Project key `p`: 12 base32 characters from the canonical project path. Aliases live in
  the project table and never require child-row rewrites.

## Field Expectations

Every field has a clamp band and an absurdity bound. Values in the clamp band are domain
values. Values between the clamp band and absurdity bound are deterministically truncated
with `{originalBytes, omittedBytes, hash, previewBytes}`. Values beyond the absurdity
bound are not the modeled thing: the adapter prunes named provider garbage or quarantines
the source unit with a diagnostic naming file, session, field, and observed size. Breached
rows emit zero domain records.

| Field | Clamp band | Absurdity bound | Breach behavior |
| --- | ---: | ---: | --- |
| `message.x` | 64 KiB | 256 KiB | truncate in-band, quarantine beyond |
| `tool.input` | 16 KiB | 64 KiB | truncate in-band, quarantine beyond |
| `tool.output` | 32 KiB | 128 KiB | truncate in-band, quarantine beyond |
| session events | 1,000,000 | 1,000,000 | reject beyond bound |
| session tool calls | 200,000 | 200,000 | reject beyond bound |
| envelope bytes | 512 KiB | 512 KiB | reject before send |
| envelope records | 800 | 800 | reject before send |
| session token | 16 base32 chars | exact | reject |
| project key | 12 base32 chars | exact | reject |
| nesting depth | provider-specific bounded reader | provider-specific | prune/quarantine |

Domain construction uses Effect Schema branded types for bounded text, identities, and
sequences. Out-of-bound values are not representable as sync-domain values.

## Measurement Gates

The permanent harness is `bun run sync-contract:check`; `bun run verify` runs it.

Gates:

- sample amplification <= 1.3x for one-session samples;
- per-record structural overhead <= 116 bytes for message/tool records;
- tool input/output caps retain at least 95% of real sample payload bytes;
- harness runtime < 60 seconds;
- absurd boundary fixtures reject without materializing the blob;
- derivable record types fail tests if reintroduced.

Full-corpus glyphs keep the frozen denominator and raise the amplification gate to <=1.5x.
