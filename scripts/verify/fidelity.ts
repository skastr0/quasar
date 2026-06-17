/**
 * BATTERY (e) — READ FIDELITY
 *
 * Samples 2 sessions per provider (10 total) DETERMINISTICALLY by stored
 * messageCount tiers: per provider, sessions with messageCount >= 1 are
 * sorted by (messageCount, sessionId) and the median-tier and top-tier
 * sessions are picked. Each sampled session is read to completion through the
 * paginated `readSession` query and compared row-by-row against an
 * INDEPENDENT source parse (scripts/verify/lib/independent.ts — no ingest
 * code imports) on (seq, role, normalized 80-char text prefix).
 *
 * Divergences are classified:
 *   - match                  (seq, role, prefix) all agree;
 *   - redaction              prefixes differ and the stored text carries the
 *                            mandatory redaction marker — the safety line is
 *                            expected to rewrite source text;
 *   - machinery-dump         a stored row the documented mapping forbids,
 *                            whose text is a machinery JSON envelope dump —
 *                            the KNOWN product defect named by reconciliation
 *                            (battery a); classified here, counted, not fatal
 *                            to THIS battery (reconciliation stays red);
 *   - live-growth            trailing source rows beyond the last stored seq
 *                            on file-backed providers — the source grew after
 *                            the last ingest;
 *   - unexplained            anything else.
 *
 * Nonzero exit on any unexplained divergence.
 */
import { convexClient, readSessionMessages, walkEstateSessions, type EstateSession } from "./lib/estate";
import {
  parseAntigravitySession,
  collapse,
  expectedSessionId,
  hermesDbPaths,
  hermesSessionIds,
  loadMachineId,
  opencodeDbPath,
  opencodeSessionIds,
  parseClaudeSession,
  parseCodexSession,
  parseGrokSession,
  parseHermesSession,
  parseOpencodeSession,
  withDbCopy,
  type TurnRow,
} from "./lib/independent";

const PROVIDERS = ["claude", "codex", "opencode", "hermes", "grok", "antigravity"] as const;
const PREFIX = 80;

const normalize = (text: string): string => collapse(text).slice(0, PREFIX);

const isMachineryDump = (text: string): boolean => collapse(text).startsWith('{"type":');

/** A stored row can carry leading machinery-dump segments joined onto real
 * text (the known product defect inside a row). Strip them so the genuine
 * text can still be compared. Returns how many segments were removed. */
const stripLeadingDumps = (text: string): { text: string; stripped: number } => {
  let current = collapse(text);
  let stripped = 0;
  for (;;) {
    const next = current.replace(/^\{"type":"[a-z0-9_-]+"\}\s*/i, "");
    if (next === current) return { text: current, stripped };
    current = next;
    stripped += 1;
  }
};

interface ClassifiedSession {
  readonly session: EstateSession;
  readonly matched: number;
  readonly redaction: number;
  readonly machineryDump: number;
  readonly liveGrowth: number;
  readonly unexplained: string[];
}

const classifySession = (
  session: EstateSession,
  stored: readonly { seq: number; role: string; text: string }[],
  expected: readonly TurnRow[],
  fileBacked: boolean,
): ClassifiedSession => {
  let matched = 0;
  let redaction = 0;
  let machineryDump = 0;
  let liveGrowth = 0;
  const unexplained: string[] = [];
  let s = 0;
  let e = 0;
  const lastStoredSeq = stored.length === 0 ? -1 : stored[stored.length - 1]!.seq;
  while (s < stored.length || e < expected.length) {
    const st = stored[s];
    const ex = expected[e];
    if (st !== undefined && ex !== undefined && st.seq === ex.seq && st.role === ex.role) {
      const stN = normalize(st.text);
      const exN = normalize(ex.text);
      const deDumped = stripLeadingDumps(st.text);
      if (stN === exN) matched += 1;
      else if (deDumped.stripped > 0 && deDumped.text.slice(0, PREFIX) === exN) {
        machineryDump += 1; // dump segments joined onto genuine text (known defect)
      } else if (st.text.includes("[redacted")) redaction += 1;
      else {
        unexplained.push(
          `seq ${st.seq} (${st.role}): text mismatch — stored "${stN.slice(0, 50)}…" vs source "${exN.slice(0, 50)}…"`,
        );
      }
      s += 1;
      e += 1;
      continue;
    }
    // Heads disagree on (seq, role): decide which side carries the extra row.
    const storedExtra =
      st !== undefined && (ex === undefined || st.seq < ex.seq || (st.seq === ex.seq && isMachineryDump(st.text)));
    if (storedExtra) {
      if (isMachineryDump(st!.text)) machineryDump += 1;
      else {
        unexplained.push(
          `seq ${st!.seq} (${st!.role}): stored row has no source counterpart — "${normalize(st!.text).slice(0, 50)}…"`,
        );
      }
      s += 1;
      continue;
    }
    // Source-only row.
    if (fileBacked && ex!.seq > lastStoredSeq) {
      liveGrowth += 1; // source extended past the ingested tail
    } else {
      unexplained.push(
        `seq ${ex!.seq} (${ex!.role}): source row missing from the backend — "${normalize(ex!.text).slice(0, 50)}…"`,
      );
    }
    e += 1;
  }
  return { session, matched, redaction, machineryDump, liveGrowth, unexplained };
};

/** Median-tier and top-tier picks over (messageCount, sessionId) order. */
const samplesFor = (sessions: EstateSession[]): EstateSession[] => {
  const eligible = sessions
    .filter((session) => session.messageCount >= 1)
    .sort((a, b) => a.messageCount - b.messageCount || a.sessionId.localeCompare(b.sessionId));
  if (eligible.length === 0) return [];
  const median = eligible[Math.floor((eligible.length - 1) / 2)]!;
  const top = eligible[eligible.length - 1]!;
  return median.sessionId === top.sessionId ? [median] : [median, top];
};

const main = async () => {
  console.log("READ FIDELITY — 2 deterministic samples per provider, paged readSession vs independent parse\n");
  const client = convexClient();
  const estate = await walkEstateSessions(client);
  const machineId = loadMachineId();

  // Reverse maps from stored sessionId → native db session id.
  const nativeBySessionId = new Map<string, string>();
  const opencodeDb = opencodeDbPath();
  const opencodeSource = estate.find((s) => s.provider === "opencode")?.sourcePath;
  if (opencodeDb !== undefined && opencodeSource !== undefined) {
    withDbCopy(opencodeDb, (db) => {
      for (const id of opencodeSessionIds(db)) {
        nativeBySessionId.set(expectedSessionId("opencode", machineId, id, opencodeSource), id);
      }
    });
  }
  const hermesSources = new Set(estate.filter((s) => s.provider === "hermes").map((s) => s.sourcePath));
  for (const dbPath of hermesDbPaths()) {
    if (!hermesSources.has(dbPath)) continue;
    withDbCopy(dbPath, (db) => {
      for (const id of hermesSessionIds(db)) {
        nativeBySessionId.set(expectedSessionId("hermes", machineId, id, dbPath), id);
      }
    });
  }

  const results: ClassifiedSession[] = [];
  for (const provider of PROVIDERS) {
    const samples = samplesFor(estate.filter((session) => session.provider === provider));
    if (samples.length === 0) {
      console.log(`${provider}: no eligible sessions — breach`);
      process.exitCode = 1;
      continue;
    }
    for (const sample of samples) {
      const stored = await readSessionMessages(client, sample.sessionId);
      let expected: TurnRow[];
      if (provider === "claude") expected = parseClaudeSession(sample.sourcePath).messages;
      else if (provider === "codex") expected = parseCodexSession(sample.sourcePath).messages;
      else if (provider === "grok") expected = parseGrokSession(sample.sourcePath).messages;
      else if (provider === "antigravity") expected = parseAntigravitySession(sample.sourcePath).messages;
      else {
        const native = nativeBySessionId.get(sample.sessionId);
        if (native === undefined) {
          console.log(`${provider} ${sample.sessionId}: no native db session resolves to this id — breach`);
          process.exitCode = 1;
          continue;
        }
        expected =
          provider === "opencode"
            ? withDbCopy(opencodeDb!, (db) => parseOpencodeSession(db, native).messages)
            : withDbCopy(sample.sourcePath, (db) => parseHermesSession(db, native).messages);
      }
      const fileBacked =
        provider === "claude" ||
        provider === "codex" ||
        provider === "grok" ||
        provider === "antigravity";
      results.push(classifySession(sample, stored, expected, fileBacked));
    }
  }

  let unexplainedTotal = 0;
  for (const result of results) {
    const { session } = result;
    const flags = [
      `matched=${result.matched}`,
      result.redaction > 0 ? `redaction=${result.redaction}` : undefined,
      result.machineryDump > 0 ? `machinery-dump=${result.machineryDump} (known defect)` : undefined,
      result.liveGrowth > 0 ? `live-growth=${result.liveGrowth}` : undefined,
      result.unexplained.length > 0 ? `UNEXPLAINED=${result.unexplained.length}` : undefined,
    ].filter((flag): flag is string => flag !== undefined);
    console.log(
      `${session.provider.padEnd(9)} ${session.sessionId.slice(-12)} stored=${session.messageCount.toString().padStart(5)} ${flags.join(" ")}`,
    );
    for (const line of result.unexplained.slice(0, 5)) console.log(`    ! ${line}`);
    if (result.unexplained.length > 5) {
      console.log(`    ! … ${result.unexplained.length - 5} more`);
    }
    unexplainedTotal += result.unexplained.length;
  }

  console.log();
  const dumps = results.reduce((sum, result) => sum + result.machineryDump, 0);
  if (dumps > 0) {
    console.log(
      `note: ${dumps} machinery-dump rows classified — the KNOWN product defect held red by reconciliation (battery a).`,
    );
  }
  if (unexplainedTotal === 0 && process.exitCode !== 1) {
    console.log(`READ FIDELITY: PASS — ${results.length} sessions, every divergence classified.`);
    return;
  }
  console.log(`READ FIDELITY: FAIL — ${unexplainedTotal} unexplained divergence(s).`);
  process.exit(1);
};

await main();
