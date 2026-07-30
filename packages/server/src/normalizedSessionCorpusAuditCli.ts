#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
  decodeAtifTrajectorySync,
  decodeLettaTrajectorySync,
  decodeMappedSessionSync,
  decodeQuasarTrajectorySync,
  projectQuasarTrajectory,
  toAtifTrajectory,
  toLettaTrajectory,
} from "@skastr0/quasar-protocol";
import { Effect } from "effect";

import { LocalStore, makeReadonlyLocalStoreLayer, openReadonlySqlite } from "./store";

const args = process.argv.slice(2);

const valueFor = (name: string): string | undefined => {
  const index = args.lastIndexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const positiveIntFor = (name: string, fallback: number): number => {
  const raw = valueFor(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const usage = (): void => {
  process.stdout.write(`Usage:
  bun run audit:normalized-corpus --db /path/to/quasar.sqlite

Options:
  --db              Required SQLite database. Run this against disposable proof state.
  --progress-every  Emit an aggregate progress receipt to stderr every N sessions. Default 100.
  --max-errors      Maximum actionable failures included in the JSON report. Default 100.

The audit rehydrates every stored normalized session through LocalStore, renders
the Quasar, Letta, and Harbor ATIF projections, validates each projection, and
then validates every complete recursive subagent tree. It never emits session
text or tool payloads.
`);
};

if (args.includes("--help")) {
  usage();
  process.exit(0);
}

const dbArgument = valueFor("--db");
if (dbArgument === undefined || dbArgument.trim() === "") {
  usage();
  process.stderr.write("Missing required --db\n");
  process.exit(1);
}

const dbPath = resolve(dbArgument);
const progressEvery = positiveIntFor("--progress-every", 100);
const maxErrors = positiveIntFor("--max-errors", 100);
const startedAt = Date.now();

interface MutableFactCounts {
  sessions: number;
  contentBlocks: number;
  messages: number;
  toolCalls: number;
  events: number;
  usageRecords: number;
  sessionEdges: number;
  artifacts: number;
  executionContexts: number;
}

interface AuditFailure {
  readonly stage:
    | "read"
    | "mapped"
    | "quasar"
    | "letta"
    | "atif"
    | "recursive_atif";
  readonly provider: string;
  readonly errorType: string;
  readonly errorFingerprint: string;
  count: number;
}

const emptyCounts = (): MutableFactCounts => ({
  sessions: 0,
  contentBlocks: 0,
  messages: 0,
  toolCalls: 0,
  events: 0,
  usageRecords: 0,
  sessionEdges: 0,
  artifacts: 0,
  executionContexts: 0,
});

const addSessionCounts = (
  counts: MutableFactCounts,
  mapped: {
    readonly messages: readonly unknown[];
    readonly toolCalls: readonly unknown[];
    readonly events: ReadonlyArray<{
      readonly contentBlocks: readonly unknown[];
    }>;
    readonly usageRecords: readonly unknown[];
    readonly sessionEdges: readonly unknown[];
    readonly artifacts: readonly unknown[];
    readonly executionContexts: readonly unknown[];
  },
): void => {
  counts.sessions += 1;
  counts.contentBlocks += mapped.events.reduce(
    (total, event) => total + event.contentBlocks.length,
    0,
  );
  counts.messages += mapped.messages.length;
  counts.toolCalls += mapped.toolCalls.length;
  counts.events += mapped.events.length;
  counts.usageRecords += mapped.usageRecords.length;
  counts.sessionEdges += mapped.sessionEdges.length;
  counts.artifacts += mapped.artifacts.length;
  counts.executionContexts += mapped.executionContexts.length;
};

const providerFromSessionId = (sessionId: string): string =>
  sessionId.includes(":") ? sessionId.slice(0, sessionId.indexOf(":")) : "unknown";

const errorDescriptor = (error: unknown): {
  readonly errorType: string;
  readonly errorFingerprint: string;
} => {
  const rendered = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    errorFingerprint: createHash("sha256")
      .update(rendered)
      .digest("hex")
      .slice(0, 16),
  };
};

const reportFatalAuditFailure = (error: unknown): never => {
  const descriptor = errorDescriptor(error);
  process.stdout.write(`${JSON.stringify({
    ok: false,
    command: "normalized-session-corpus-audit",
    errors: {
      count: 1,
      distinct: 1,
      returned: 1,
      truncated: false,
      failures: [{
        stage: "read",
        provider: "unknown",
        ...descriptor,
        count: 1,
      }],
    },
  }, null, 2)}\n`);
  process.exit(1);
};

process.once("uncaughtException", reportFatalAuditFailure);
process.once("unhandledRejection", reportFatalAuditFailure);

try {
  if (statSync(`${dbPath}-wal`).size > 0) {
    reportFatalAuditFailure(new Error("database_has_uncheckpointed_wal"));
  }
} catch (error) {
  if (
    typeof error !== "object"
    || error === null
    || !("code" in error)
    || (error as { readonly code?: string }).code !== "ENOENT"
  ) {
    reportFatalAuditFailure(error);
  }
}

type LettaIssueKind =
  ReturnType<typeof toLettaTrajectory>["compatibility"]["issues"][number]["kind"];

const LETTA_ISSUE_KINDS = [
  "mixed_assistant_split",
  "event_meta_omitted",
  "missing_or_invalid_timestamp",
  "quasar_metadata_omitted",
  "tool_result_truncated",
  "tool_call_timestamps_coalesced",
] as const satisfies readonly LettaIssueKind[];

const emptyLettaIssueCounts = (): Record<LettaIssueKind, number> =>
  Object.fromEntries(
    LETTA_ISSUE_KINDS.map((kind) => [kind, 0]),
  ) as Record<LettaIssueKind, number>;

type AtifCompatibilityCounts =
  ReturnType<typeof toAtifTrajectory>["compatibility"]["counts"];

type MutableAtifCompatibilityCounts = {
  -readonly [Key in keyof AtifCompatibilityCounts]: number;
};

const emptyAtifCompatibilityCounts = (): MutableAtifCompatibilityCounts => ({
  sourceSessions: 0,
  sourceEvents: 0,
  sourceToolCalls: 0,
  sourceUsageRecords: 0,
  sourceSessionEdges: 0,
  sourceArtifacts: 0,
  sourceExecutionContexts: 0,
  outputSteps: 0,
  embeddedSubagents: 0,
  mappedCore: 0,
  mappedExtension: 0,
  omittedByPolicy: 0,
  unobservedAtifFields: 0,
  projectionAdjustments: 0,
});

const addAtifCompatibilityCounts = (
  target: MutableAtifCompatibilityCounts,
  source: AtifCompatibilityCounts,
): void => {
  for (const key of Object.keys(target) as Array<keyof AtifCompatibilityCounts>) {
    target[key] += source[key];
  }
};

const lineageDb = openReadonlySqlite(dbPath);
const lineage = (() => {
  try {
    const childSessions = (
      lineageDb.query(
        "SELECT COUNT(*) AS count FROM sessions WHERE parent_session_id IS NOT NULL",
      ).get() as { readonly count: number }
    ).count;
    const danglingParentSessions = (
      lineageDb.query(
        `SELECT COUNT(*) AS count
         FROM sessions AS child
         LEFT JOIN sessions AS parent
           ON parent.session_id = child.parent_session_id
         WHERE child.parent_session_id IS NOT NULL
           AND parent.session_id IS NULL`,
      ).get() as { readonly count: number }
    ).count;
    const completeRootIds = (
      lineageDb.query(
        `SELECT DISTINCT child.parent_session_id AS sessionId
         FROM sessions AS child
         INNER JOIN sessions AS parent
           ON parent.session_id = child.parent_session_id
         WHERE child.parent_session_id IS NOT NULL
         ORDER BY child.parent_session_id`,
      ).all() as Array<{ readonly sessionId: string }>
    ).map(({ sessionId }) => sessionId);
    return { childSessions, danglingParentSessions, completeRootIds };
  } finally {
    lineageDb.close();
  }
})();

const report = await Effect.runPromise(
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const sessionIds = yield* store.querySessionIds({});
    const totals = emptyCounts();
    const providers: Record<string, MutableFactCounts> = {};
    const failures: AuditFailure[] = [];
    const failureGroups = new Map<string, AuditFailure>();
    let errorCount = 0;
    let mappedSessions = 0;
    let quasarTrajectories = 0;
    let lettaTrajectories = 0;
    let atifTrajectories = 0;
    let recursiveAtifRoots = 0;
    const lettaIssues = emptyLettaIssueCounts();
    const atifCompatibility = emptyAtifCompatibilityCounts();
    const recursiveAtifCompatibility = emptyAtifCompatibilityCounts();

    const recordFailure = (
      stage: AuditFailure["stage"],
      provider: string,
      error: unknown,
    ): void => {
      errorCount += 1;
      const descriptor = errorDescriptor(error);
      const key = [
        stage,
        provider,
        descriptor.errorType,
        descriptor.errorFingerprint,
      ].join(":");
      const existing = failureGroups.get(key);
      if (existing !== undefined) {
        existing.count += 1;
        return;
      }
      const failure = {
        stage,
        provider,
        ...descriptor,
        count: 1,
      };
      failureGroups.set(key, failure);
      if (failures.length < maxErrors) failures.push(failure);
    };

    const recordProgress = (
      phase: "sessions" | "recursive_atif",
      checked: number,
      total: number,
    ): void => {
      if (checked % progressEvery !== 0 && checked !== total) return;
      process.stderr.write(`${JSON.stringify({
        event: "normalized_corpus_audit.progress",
        phase,
        checked,
        total,
        errors: errorCount,
      })}\n`);
    };

    for (const [index, sessionId] of sessionIds.entries()) {
      const provider = providerFromSessionId(sessionId);
      const read = yield* Effect.either(store.readMappedSession(sessionId));
      if (read._tag === "Left") {
        recordFailure("read", provider, read.left);
        recordProgress("sessions", index + 1, sessionIds.length);
        continue;
      }
      const mapped = read.right;
      if (mapped === undefined) {
        recordFailure("read", provider, new Error("session_disappeared"));
        recordProgress("sessions", index + 1, sessionIds.length);
        continue;
      }

      try {
        decodeMappedSessionSync(mapped);
        mappedSessions += 1;
      } catch (error) {
        recordFailure("mapped", provider, error);
        recordProgress("sessions", index + 1, sessionIds.length);
        continue;
      }

      addSessionCounts(totals, mapped);
      const providerCounts = providers[mapped.session.provider]
        ?? (providers[mapped.session.provider] = emptyCounts());
      addSessionCounts(providerCounts, mapped);

      let quasar;
      try {
        quasar = projectQuasarTrajectory(mapped);
        decodeQuasarTrajectorySync(quasar);
        quasarTrajectories += 1;
      } catch (error) {
        recordFailure("quasar", provider, error);
        recordProgress("sessions", index + 1, sessionIds.length);
        continue;
      }

      try {
        const letta = toLettaTrajectory(quasar);
        decodeLettaTrajectorySync(letta.trajectory);
        for (const issue of letta.compatibility.issues) {
          lettaIssues[issue.kind] += 1;
        }
        lettaTrajectories += 1;
      } catch (error) {
        recordFailure("letta", provider, error);
      }

      try {
        const atif = toAtifTrajectory(mapped);
        decodeAtifTrajectorySync(atif.trajectory);
        addAtifCompatibilityCounts(
          atifCompatibility,
          atif.compatibility.counts,
        );
        atifTrajectories += 1;
      } catch (error) {
        recordFailure("atif", provider, error);
      }

      recordProgress("sessions", index + 1, sessionIds.length);
    }

    for (const [index, rootId] of lineage.completeRootIds.entries()) {
      const rootRead = yield* Effect.either(store.readMappedSession(rootId));
      const descendantsRead = yield* Effect.either(
        store.readMappedSessionDescendants(rootId),
      );
      if (
        rootRead._tag === "Left"
        || descendantsRead._tag === "Left"
        || rootRead.right === undefined
      ) {
        recordFailure(
          "recursive_atif",
          providerFromSessionId(rootId),
          rootRead._tag === "Left"
            ? rootRead.left
            : descendantsRead._tag === "Left"
              ? descendantsRead.left
              : new Error("root_session_disappeared"),
        );
        recordProgress(
          "recursive_atif",
          index + 1,
          lineage.completeRootIds.length,
        );
        continue;
      }
      try {
        const exported = toAtifTrajectory(rootRead.right, {
          subagentSessions: descendantsRead.right,
        });
        decodeAtifTrajectorySync(exported.trajectory);
        addAtifCompatibilityCounts(
          recursiveAtifCompatibility,
          exported.compatibility.counts,
        );
        recursiveAtifRoots += 1;
      } catch (error) {
        recordFailure(
          "recursive_atif",
          providerFromSessionId(rootId),
          error,
        );
      }
      recordProgress(
        "recursive_atif",
        index + 1,
        lineage.completeRootIds.length,
      );
    }

    const projections = {
      quasar: quasarTrajectories,
      letta: lettaTrajectories,
      atif: atifTrajectories,
      recursiveAtifRoots,
    };
    const ok = errorCount === 0
      && totals.sessions === sessionIds.length
      && mappedSessions === sessionIds.length
      && quasarTrajectories === sessionIds.length
      && lettaTrajectories === sessionIds.length
      && atifTrajectories === sessionIds.length
      && recursiveAtifRoots === lineage.completeRootIds.length;

    return {
      ok,
      command: "normalized-session-corpus-audit",
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      sessionsDiscovered: sessionIds.length,
      mappedSessions,
      facts: totals,
      projections,
      compatibility: {
        letta: {
          issues: Object.values(lettaIssues).reduce(
            (total, count) => total + count,
            0,
          ),
          issuesByKind: lettaIssues,
        },
        atif: {
          singleSession: atifCompatibility,
          recursive: recursiveAtifCompatibility,
        },
      },
      providers: Object.fromEntries(
        Object.entries(providers).sort(([left], [right]) =>
          left.localeCompare(right)
        ),
      ),
      lineage: {
        childSessions: lineage.childSessions,
        danglingParentSessions: lineage.danglingParentSessions,
        completeRoots: lineage.completeRootIds.length,
      },
      errors: {
        count: errorCount,
        returned: failures.length,
        distinct: failureGroups.size,
        truncated: failureGroups.size > failures.length,
        failures,
      },
    };
  }).pipe(Effect.provide(makeReadonlyLocalStoreLayer(dbPath))),
);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
