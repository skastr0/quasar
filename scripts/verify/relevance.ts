/**
 * BATTERY (d) — PINNED RELEVANCE
 *
 * Pinned, source-verified search fixtures: distinctive terms (error names,
 * tool names, architecture words — never stopwords) that were FIRST verified
 * to exist verbatim in the raw provider source of a specific session
 * (grep over JSONL files / sqlite LIKE over message+part rows, authoring run
 * 2026-06-11), and are asserted to surface that exact session through the
 * live `searchMessages` query.
 *
 * Coverage: all five providers (claude, codex, opencode, hermes, grok) and
 * nine distinct projects. Reasoning-row fixtures are included deliberately —
 * reasoning is lexically searchable by contract (embedding exclusion is a
 * separate, pending decision and does not affect this battery).
 *
 * A fixture fails when the expected session is absent from the top
 * `SEARCH_LIMIT` hits. Nonzero exit on any failure, naming query, expected
 * session, and what came back instead.
 */
import { convexClient, searchMessages } from "./lib/estate";

const SEARCH_LIMIT = 20;
const MACHINE = "machine:129e961e0b9e7b47c3c6ed3084b11cd1";

interface Fixture {
  readonly query: string;
  readonly projectKey?: string;
  readonly provider: "claude" | "codex" | "opencode" | "hermes" | "grok";
  /** The session, verified at authoring time to contain the term in its raw source. */
  readonly expectSessionId: string;
  /** Where the term was verified in real source. */
  readonly evidence: string;
}

const FIXTURES: readonly Fixture[] = [
  // ----- claude --------------------------------------------------------
  {
    query: "pruneEmptyProjects",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "claude",
    expectSessionId: `claude:${MACHINE}:ac7b3487d86db0380dbdef8d5bb91ace`,
    evidence: "~/.claude/projects/-Users-guilhermecastro-Projects-quasar JSONL contains the mutation name",
  },
  {
    query: "sourceFingerprint",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "claude",
    expectSessionId: `claude:${MACHINE}:ea5ec0a4620aba09ae2ef32606fe507b`,
    evidence: "claude quasar session discussing the idempotency field",
  },
  {
    query: "filterFields",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "claude",
    expectSessionId: `claude:${MACHINE}:e7e0373b21b53922736ec8f1231cee20`,
    evidence: "claude quasar validation session quoting the search-index declaration",
  },
  {
    query: "omegacode",
    projectKey: "git:github.com/skastr0/prism",
    provider: "claude",
    expectSessionId: `claude:${MACHINE}:4e7b30ece8f1715323a9cb663d281e2d`,
    evidence: "claude prism session exploring ~/Playground/omegacode",
  },
  // ----- codex ---------------------------------------------------------
  {
    query: "TooManyWrites",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "codex",
    expectSessionId: `codex:${MACHINE}:400d8112d5ad1a230be9240cf7e85835`,
    evidence: "codex rollout for the storage-growth halt names the Convex error",
  },
  {
    query: "amplification",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "codex",
    expectSessionId: `codex:${MACHINE}:4100f905caaf6e70521483d769eefe52`,
    evidence: "codex rollout: 'explain the wire amplification please' user turn",
  },
  {
    query: "production-ready-goal",
    projectKey: "git:github.com/skastr0/atlas",
    provider: "codex",
    expectSessionId: `codex:${MACHINE}:dbfe380780ddae8ea0875c514ebb6c10`,
    evidence: "codex atlas rollout creating production-ready-goal.md",
  },
  {
    query: "boothRuntimeConfig",
    projectKey: "git:github.com/skastr0/booth-control",
    provider: "codex",
    expectSessionId: `codex:${MACHINE}:0660d2563d3d70f76b0eaee42643c95d`,
    evidence: "codex booth-control review rollout naming the config symbol",
  },
  // ----- opencode ------------------------------------------------------
  {
    query: "OSSignposter",
    projectKey: "git:github.com/skastr0/ripple",
    provider: "opencode",
    expectSessionId: `opencode:${MACHINE}:83c8ddc84f2a9a45924082b204b18b3f`,
    evidence: "opencode-local.db part rows (ripple observability session) name the Apple API",
  },
  {
    query: "xctrace",
    projectKey: "git:github.com/skastr0/probe-cli",
    provider: "opencode",
    expectSessionId: `opencode:${MACHINE}:292ff17db4c8ca440d6bb3ff60b4622e`,
    evidence: "opencode-local.db reasoning parts on the probe-cli instruments work",
  },
  {
    query: "typefully",
    projectKey: "git:github.com/skastr0/typefully-cli",
    provider: "opencode",
    expectSessionId: `opencode:${MACHINE}:02be4089f26ec51c8e9f16af1b30b4d2`,
    evidence: "opencode-local.db typefully-cli contract review session",
  },
  // ----- hermes --------------------------------------------------------
  {
    query: "Kepler",
    provider: "hermes",
    expectSessionId: `hermes:${MACHINE}:3082b32109c9cea28d50d40f77249868`,
    evidence: "~/.hermes/state.db messages on the KEPLER-09 profile-image work",
  },
  {
    query: "ethereal",
    provider: "hermes",
    expectSessionId: `hermes:${MACHINE}:b009f2d9391bcbf26c3720e77936de30`,
    evidence: "~/.hermes/state.db: 'similar to yours actually but maybe more ethereal'",
  },
  // ----- grok ----------------------------------------------------------
  {
    query: "your-username",
    projectKey: "git:github.com/skastr0/atlas",
    provider: "grok",
    expectSessionId: `grok:${MACHINE}:5253046f54e01b1a3e660eb9e0f3bb1c`,
    evidence: "grok atlas chat_history reasoning: Cargo.toml placeholder github.com/your-username",
  },
  {
    query: "system-config",
    projectKey: "git:github.com/skastr0/rig",
    provider: "grok",
    expectSessionId: `grok:${MACHINE}:6387e1ec64fca5c1efbfe682dd4417d7`,
    evidence: "grok rig chat_history: booth-* projects added to system-config.json",
  },
  {
    query: "blob-split",
    projectKey: "git:github.com/skastr0/quasar",
    provider: "grok",
    expectSessionId: `grok:${MACHINE}:8a23d72b2c49adacce50c63df5c93716`,
    evidence: "grok quasar architecture-review chat_history names the blob-split design",
  },
];

const main = async () => {
  console.log(
    `PINNED RELEVANCE — ${FIXTURES.length} source-verified fixtures, top-${SEARCH_LIMIT} assertion\n`,
  );
  const client = convexClient();
  const failures: string[] = [];
  const providers = new Set<string>();
  const projects = new Set<string>();
  for (const fixture of FIXTURES) {
    providers.add(fixture.provider);
    if (fixture.projectKey !== undefined) projects.add(fixture.projectKey);
    const hits = await searchMessages(client, {
      query: fixture.query,
      ...(fixture.projectKey !== undefined ? { projectKey: fixture.projectKey } : {}),
      limit: SEARCH_LIMIT,
    });
    const matched = hits.find((hit) => hit.sessionId === fixture.expectSessionId);
    const providerOk = matched?.sessionId.startsWith(`${fixture.provider}:`) ?? false;
    const status = matched !== undefined && providerOk ? "ok " : "MISS";
    console.log(
      `${status} ${fixture.provider.padEnd(8)} ${JSON.stringify(fixture.query).padEnd(24)} ${fixture.projectKey ?? "(unfiltered)"}`,
    );
    if (matched === undefined) {
      const got = [...new Set(hits.map((hit) => hit.sessionId))].slice(0, 5);
      failures.push(
        `query ${JSON.stringify(fixture.query)}${fixture.projectKey !== undefined ? ` in ${fixture.projectKey}` : ""}: expected session ${fixture.expectSessionId} (${fixture.evidence}) absent from top ${SEARCH_LIMIT}; got ${hits.length} hits${got.length > 0 ? ` from sessions [${got.join(", ")}]` : ""}`,
      );
    }
  }
  console.log();
  if (providers.size !== 5) {
    failures.push(`fixture set covers ${providers.size}/5 providers — battery contract requires all five`);
  }
  if (projects.size < 3) {
    failures.push(`fixture set covers ${projects.size} projects — battery contract requires at least 3`);
  }
  if (failures.length === 0) {
    console.log(
      `PINNED RELEVANCE: PASS — ${FIXTURES.length} fixtures across ${providers.size} providers / ${projects.size} projects.`,
    );
    return;
  }
  console.log(`PINNED RELEVANCE: FAIL — ${failures.length} failure(s):`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
};

await main();
