#!/usr/bin/env bun
/**
 * Targeted Grok recovery gate.
 *
 * Runs the archive-aware Grok adapter against ONE session directory, maps the
 * result exactly as ingest would, and verifies every preserved canonical
 * message (from the incident evidence comparison JSON) against the projected
 * messages with ordered injective matching.
 *
 * Read-only: no server call, no database write, no daemon. The caller replays
 * only the sessions that exit 0.
 *
 * Exit codes:
 *   0  every preserved canonical occurrence resolves; safe to replay
 *   1  usage/error
 *   2  session failed closed by the adapter (stored session left unchanged)
 *   3  unresolved canonical occurrences; DO NOT replay this session
 *
 * Usage:
 *   bun scripts/grok-recovery-verify.ts \
 *     --session-dir "$HOME/.grok/sessions/<project>/<session-uuid>" \
 *     --evidence /path/to/grok-<session-id>-comparison.json \
 *     [--stored-tool-calls /path/to/stored-tool-calls.ndjson]
 *
 * `--stored-tool-calls` is the NDJSON `items[]` stream from a read-only
 * `quasar tool-calls --session <id> --limit 200` page walk. When provided, the
 * gate also proves every stored tool call is retained by identity, name,
 * status, payload byte length and cross-event chronology.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { grokAdapter } from "../packages/cli/src/adapters/grok";
import {
  countExcessMessageOccurrences,
  verifyRecoveredTexts,
  verifyToolCallRetention,
  type GrokStoredToolCall,
} from "../packages/cli/src/adapters/grok-recovery";
import { mapSession } from "../packages/cli/src/map";

type Options = {
  readonly sessionDir: string;
  readonly evidence: string;
  readonly storedToolCalls?: string;
};

const parseArgs = (argv: readonly string[]): Options => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, next);
    index += 1;
  }
  const sessionDir = values.get("--session-dir");
  const evidence = values.get("--evidence");
  if (sessionDir === undefined || evidence === undefined) {
    throw new Error("usage: --session-dir <dir> --evidence <comparison.json> [--stored-tool-calls <ndjson>]");
  }
  const storedToolCalls = values.get("--stored-tool-calls");
  return {
    sessionDir: resolve(sessionDir),
    evidence: resolve(evidence),
    ...(storedToolCalls !== undefined ? { storedToolCalls: resolve(storedToolCalls) } : {}),
  };
};

const readStoredToolCalls = (path: string): GrokStoredToolCall[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const row = JSON.parse(line) as {
        readonly toolCallId: string;
        readonly sequence: number;
        readonly toolName: string;
        readonly status?: string | null;
        readonly inputBytes: number;
        readonly outputBytes: number;
        readonly inputHash?: string;
        readonly outputHash?: string;
      };
      return {
        toolCallId: row.toolCallId,
        sequence: row.sequence,
        toolName: row.toolName,
        status: row.status ?? null,
        inputBytes: row.inputBytes,
        outputBytes: row.outputBytes,
        ...(row.inputHash !== undefined ? { inputHash: row.inputHash } : {}),
        ...(row.outputHash !== undefined ? { outputHash: row.outputHash } : {}),
      };
    });

const main = async (): Promise<number> => {
  const options = parseArgs(process.argv.slice(2));
  const comparison = JSON.parse(readFileSync(options.evidence, "utf8")) as {
    readonly old?: ReadonlyArray<{ readonly text?: unknown }>;
  };
  const oldTexts = (comparison.old ?? [])
    .map((message) => message.text)
    .filter((text): text is string => typeof text === "string");
  if (oldTexts.length === 0) {
    console.error(`FAIL evidence contains no preserved canonical messages: ${options.evidence}`);
    return 1;
  }

  const root = resolve(options.sessionDir, "..", "..", "..");
  let session: Parameters<typeof mapSession>[0] | undefined;
  let block: { readonly code: string; readonly message: string } | undefined;
  const diagnostics: string[] = [];
  for await (const item of grokAdapter.stream!({
    machine: { machineId: "machine:recovery-verify", hostname: "recovery-verify", platform: "darwin" },
    now: new Date().toISOString(),
    roots: { grok: root },
    shouldReadFile: (path) => path.startsWith(options.sessionDir),
    shouldParseSession: () => true,
  })) {
    if (item.type === "diagnostic") {
      const details = item.diagnostic.details;
      const code = details !== null && typeof details === "object"
        ? (details as { readonly diagnostic?: unknown }).diagnostic
        : undefined;
      if (
        typeof code === "string"
        && code.startsWith("grok.recovery.")
        && (details as { readonly physicalPath?: unknown }).physicalPath !== undefined
        && String((details as { readonly physicalPath?: unknown }).physicalPath).startsWith(options.sessionDir)
      ) {
        block = { code, message: item.diagnostic.message };
      }
      if (item.diagnostic.severity === "error") diagnostics.push(item.diagnostic.message);
      continue;
    }
    if (item.type !== "session") continue;
    if (!item.session.sourcePath.startsWith(options.sessionDir)) continue;
    session = item.session;
    break;
  }

  const report = {
    sessionDir: options.sessionDir,
    evidence: options.evidence,
    preserved: oldTexts.length,
  };
  if (block !== undefined) {
    console.log(JSON.stringify({ ...report, outcome: "held_closed", code: block.code, message: block.message }, null, 2));
    return 2;
  }
  if (session === undefined) {
    console.error(JSON.stringify({ ...report, outcome: "not_found", diagnostics }, null, 2));
    return 1;
  }
  const mapped = mapSession(session, "recovery-verify");
  const newTexts = mapped.messages.map((message) => message.text);
  const verification = verifyRecoveredTexts(oldTexts, newTexts);
  const excessMessageOccurrences = countExcessMessageOccurrences(oldTexts, newTexts);
  const toolRetention = options.storedToolCalls === undefined
    ? undefined
    : verifyToolCallRetention(readStoredToolCalls(options.storedToolCalls), mapped.toolCalls);
  const toolFailures = toolRetention === undefined
    ? 0
    : toolRetention.missing.length
      + toolRetention.toolNameMismatches.length
      + toolRetention.statusMismatches.length
      + toolRetention.byteMismatches.length
      + toolRetention.hashMismatches.length
      + toolRetention.duplicateRecoveredIds.length
      + toolRetention.chronologyViolations;
  const replaySafe =
    verification.unresolved.length === 0
    && excessMessageOccurrences === 0
    && toolFailures === 0;
  const unresolved = verification.unresolved.map((text) => text.slice(0, 120));
  console.log(JSON.stringify({
    ...report,
    outcome: replaySafe ? "replay_safe" : "unresolved",
    projectedMessages: mapped.messages.length,
    projectedToolCalls: mapped.toolCalls.length,
    resolved: verification.resolved,
    unresolvedCount: verification.unresolved.length,
    unresolved,
    excessMessageOccurrences,
    ...(toolRetention !== undefined ? { toolRetention } : {}),
  }, null, 2));
  return replaySafe ? 0 : 3;
};

main().then((code) => {
  process.exitCode = code;
}).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
