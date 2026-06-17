/**
 * BATTERY (a) — RECONCILIATION
 *
 * Per provider, an INDEPENDENT counter (direct file/SQLite parse implementing
 * the documented mapping rules — see scripts/verify/lib/independent.ts, which
 * imports nothing from the ingest pipeline) is compared against the live
 * Convex estate (paginated listProjects → listSessions walk, summing the
 * stored messageCount/toolCallCount).
 *
 * TOLERANCES (explicit, small — the corpus is live and grows during the run):
 *
 * - File-backed providers (claude, codex, grok, antigravity): source files only ever grow
 *   (Claude purge is set to 3650 days; codex archives stay scanned), so the
 *   live source count must be >= the Convex count, and the upward drift since
 *   the last ingest must stay within:
 *       sessions:  +2%   (UPPER_DRIFT_SESSIONS)
 *       messages:  +3%   (UPPER_DRIFT_ROWS)
 *       toolCalls: +3%   (UPPER_DRIFT_ROWS)
 *   plus an absolute floor of UPPER_DRIFT_FLOOR rows for tiny corpora (grok
 *   has ~13 sessions; one new session is already ~8%). Convex > source means
 *   data exists in the backend with no source counterpart — always a breach.
 *   Run `quasar ingest --provider all` first to keep drift near zero.
 *
 * - DB-backed providers (opencode, hermes): the database fingerprint
 *   (size+mtime of db and -wal) is captured before and after the independent
 *   parse. If it did not change — a quiet db — tolerance is ZERO: every
 *   count must match exactly; any missing row is named. If the db changed
 *   during the run, the file-backed drift tolerances apply for that run.
 *
 * Exit: nonzero on any breach, with each discrepancy named
 * (provider.metric: source vs convex, drift, tolerance).
 */
import {
  antigravityTotals,
  claudeTotals,
  codexTotals,
  dbFingerprint,
  grokTotals,
  hermesDbPaths,
  hermesTotals,
  opencodeDbPath,
  opencodeTotals,
  sameDbFingerprint,
  type ProviderTotals,
} from "./lib/independent";
import { convexClient, walkEstateSessions } from "./lib/estate";

const UPPER_DRIFT_SESSIONS = 0.02;
const UPPER_DRIFT_ROWS = 0.03;
/** Absolute drift floor so one new session in a tiny corpus is not a breach. */
const UPPER_DRIFT_FLOOR = 5;

const PROVIDERS = ["claude", "codex", "opencode", "hermes", "grok", "antigravity"] as const;
type ProviderName = (typeof PROVIDERS)[number];

interface Comparison {
  readonly provider: ProviderName;
  readonly metric: "sessions" | "messages" | "toolCalls";
  readonly source: number;
  readonly convex: number;
  readonly quietDb: boolean;
  /** Rows the current product is known to emit against the documented mapping
   * (machinery JSON-envelope dumps) — used to NAME the defect, never to pass. */
  readonly knownDumpRows: number;
}

const rawBreachOf = (
  c: Comparison,
  source: number,
): string | undefined => {
  if (source === c.convex) return undefined;
  const drift = source - c.convex;
  if (c.quietDb) {
    return `${c.provider}.${c.metric}: quiet db must match exactly — source=${source} convex=${c.convex} (drift ${drift > 0 ? "+" : ""}${drift})`;
  }
  if (drift < 0) {
    return `${c.provider}.${c.metric}: convex holds ${-drift} more than source (source=${source} convex=${c.convex}) — backend rows with no source counterpart`;
  }
  const rate = c.metric === "sessions" ? UPPER_DRIFT_SESSIONS : UPPER_DRIFT_ROWS;
  const allowance = Math.max(Math.ceil(c.convex * rate), UPPER_DRIFT_FLOOR);
  if (drift > allowance) {
    return `${c.provider}.${c.metric}: upward drift ${drift} exceeds tolerance ${allowance} (${(rate * 100).toFixed(0)}% of ${c.convex}, floor ${UPPER_DRIFT_FLOOR}) — source=${source} convex=${c.convex}; run ingest and re-verify`;
  }
  return undefined;
};

const breachOf = (c: Comparison): string | undefined => {
  const documented = rawBreachOf(c, c.source);
  if (documented === undefined) return undefined;
  // When the documented count fails but adding the product's known
  // machinery-dump rows reconciles it, name the defect precisely. This is a
  // REAL product defect (machinery on the search surface) and stays red.
  if (c.knownDumpRows > 0 && rawBreachOf(c, c.source + c.knownDumpRows) === undefined) {
    return `${c.provider}.${c.metric}: PRODUCT DEFECT — ${c.knownDumpRows} machinery JSON-envelope dump rows (e.g. {"type":"reasoning"} from empty parts) are stored as message rows on the search surface; documented mapping yields ${c.source}, convex holds ${c.convex}`;
  }
  return documented;
};

const main = async () => {
  console.log("RECONCILIATION — independent source parse vs live Convex estate\n");

  // Live Convex side.
  const client = convexClient();
  const estate = await walkEstateSessions(client);
  const convexTotals = new Map<string, ProviderTotals>();
  for (const session of estate) {
    const totals =
      convexTotals.get(session.provider) ??
      ({
        sessions: 0,
        messages: 0,
        toolCalls: 0,
        rejectedEvents: 0,
        machineryDumpRows: 0,
      } satisfies ProviderTotals);
    totals.sessions += 1;
    totals.messages += session.messageCount;
    totals.toolCalls += session.toolCallCount;
    convexTotals.set(session.provider, totals);
  }
  const knownProviders = new Set<string>(PROVIDERS);
  const unknownProviders = [...convexTotals.keys()].filter((p) => !knownProviders.has(p));

  // Independent source side (db fingerprints captured around the parse).
  const opencodeDb = opencodeDbPath();
  const opencodeBefore = opencodeDb === undefined ? undefined : dbFingerprint(opencodeDb);
  const hermesBefore = new Map(hermesDbPaths().map((path) => [path, dbFingerprint(path)] as const));
  const source: Record<ProviderName, ProviderTotals | undefined> = {
    claude: claudeTotals(),
    codex: codexTotals(),
    opencode: opencodeTotals(),
    hermes: hermesTotals(),
    grok: grokTotals(),
    antigravity: antigravityTotals(),
  };
  const opencodeAfter = opencodeDb === undefined ? undefined : dbFingerprint(opencodeDb);
  const hermesAfter = new Map(hermesDbPaths().map((path) => [path, dbFingerprint(path)] as const));
  const hermesQuiet =
    hermesBefore.size > 0 &&
    hermesBefore.size === hermesAfter.size &&
    [...hermesBefore].every(([path, before]) => {
      const after = hermesAfter.get(path);
      return after !== undefined && sameDbFingerprint(before, after);
    });
  const quiet: Record<ProviderName, boolean> = {
    claude: false,
    codex: false,
    grok: false,
    antigravity: false,
    opencode:
      opencodeBefore !== undefined &&
      opencodeAfter !== undefined &&
      sameDbFingerprint(opencodeBefore, opencodeAfter),
    hermes: hermesQuiet,
  };

  const breaches: string[] = [];
  const pad = (value: string | number, width: number) => String(value).padStart(width);
  console.log(
    "provider  | mode      | source: sessions  messages toolCalls | convex: sessions  messages toolCalls | rejected | dumps",
  );
  console.log("-".repeat(126));
  for (const provider of PROVIDERS) {
    const src = source[provider];
    const cvx =
      convexTotals.get(provider) ??
      ({
        sessions: 0,
        messages: 0,
        toolCalls: 0,
        rejectedEvents: 0,
        machineryDumpRows: 0,
      } satisfies ProviderTotals);
    if (src === undefined) {
      breaches.push(`${provider}: source root/database not found — independent count impossible`);
      continue;
    }
    const mode = quiet[provider] ? "quiet-db " : "live-src ";
    console.log(
      `${provider.padEnd(9)} | ${mode} |         ${pad(src.sessions, 8)} ${pad(src.messages, 9)} ${pad(src.toolCalls, 9)} |         ${pad(cvx.sessions, 8)} ${pad(cvx.messages, 9)} ${pad(cvx.toolCalls, 9)} | ${pad(src.rejectedEvents, 8)} | ${pad(src.machineryDumpRows, 5)}`,
    );
    for (const metric of ["sessions", "messages", "toolCalls"] as const) {
      const breach = breachOf({
        provider,
        metric,
        source: src[metric],
        convex: cvx[metric],
        quietDb: quiet[provider],
        knownDumpRows: metric === "messages" ? src.machineryDumpRows : 0,
      });
      if (breach !== undefined) breaches.push(breach);
    }
  }
  for (const provider of unknownProviders) {
    breaches.push(`convex holds sessions for unknown provider "${provider}" — no source counter exists`);
  }

  console.log();
  if (breaches.length === 0) {
    console.log("RECONCILIATION: PASS — every provider within documented tolerance.");
    return;
  }
  console.log(`RECONCILIATION: FAIL — ${breaches.length} named discrepanc${breaches.length === 1 ? "y" : "ies"}:`);
  for (const breach of breaches) console.log(`  - ${breach}`);
  process.exit(1);
};

await main();
