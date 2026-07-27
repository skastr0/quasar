#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Effect, Schema } from "effect";

import { LocalStore, makeReadonlyLocalStoreLayer } from "./store";

const COMMAND = "normalized-session-replay-proof";
const args = process.argv.slice(2);

const valueFor = (name: string): string | undefined => {
  const index = args.lastIndexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
};

const usage = (): void => {
  process.stdout.write(`Usage:
  bun run proof:normalized-replay --db /path/to/quasar.sqlite --server http://127.0.0.1:6180

Requirements:
  --db                  Required checkpointed SQLite database.
  --server              Required loopback Quasar server origin.
  QUASAR_INGEST_TOKEN   Required ingest token.

The proof reads every exact stored normalized session from immutable SQLite and
submits it once, sequentially, without force or retries. Every response must be
an unchanged-source skip with zero writes and zero queued jobs.
`);
};

const ProofStage = Schema.Literal(
  "arguments",
  "wal",
  "health",
  "target",
  "status",
  "preflight",
  "read",
  "post",
  "response",
);
type ProofStage = typeof ProofStage.Type;

class ReplayProofViolation extends Schema.TaggedError<ReplayProofViolation>()(
  "ReplayProofViolation",
  {
    stage: ProofStage,
    provider: Schema.String,
    fingerprintInput: Schema.String,
  },
) {}

interface MutableProviderCounts {
  sessions: number;
  attempted: number;
  skipped: number;
}

interface MutableProofState {
  sessionsDiscovered: number;
  sessionsAttempted: number;
  sessionsVerified: number;
  readonly providers: Map<string, MutableProviderCounts>;
  readonly writes: {
    messages: number;
    toolCalls: number;
    jobs: number;
  };
  readonly preflight: {
    walBytes?: number;
    targetMatched?: boolean;
    queue?: {
      pending: number;
      leased: number;
      failed: number;
    };
    activeIngestRuns?: number;
    applyingFingerprints?: number;
  };
}

const state: MutableProofState = {
  sessionsDiscovered: 0,
  sessionsAttempted: 0,
  sessionsVerified: 0,
  providers: new Map(),
  writes: {
    messages: 0,
    toolCalls: 0,
    jobs: 0,
  },
  preflight: {},
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonNegativeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const errorInput = (error: unknown): string =>
  error instanceof Error
    ? `${error.name}:${error.message}`
    : String(error);

const violation = (
  stage: ProofStage,
  fingerprintInput: string,
  provider = "unknown",
): ReplayProofViolation =>
  ReplayProofViolation.make({
    stage,
    provider,
    fingerprintInput,
  });

const descriptor = (error: unknown): {
  readonly stage: ProofStage;
  readonly provider: string;
  readonly errorType: string;
  readonly errorFingerprint: string;
} => {
  const replayError = error instanceof ReplayProofViolation
    ? error
    : violation("preflight", `unexpected:${errorInput(error)}`);
  return {
    stage: replayError.stage,
    provider: replayError.provider,
    errorType: error instanceof Error ? error.name : "UnknownError",
    errorFingerprint: createHash("sha256")
      .update(replayError.fingerprintInput)
      .digest("hex")
      .slice(0, 16),
  };
};

const sortedProviders = (): Record<string, MutableProviderCounts> =>
  Object.fromEntries(
    [...state.providers.entries()].sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  );

const report = (
  ok: boolean,
  error?: unknown,
): Record<string, unknown> => ({
  ok,
  command: COMMAND,
  sessionsDiscovered: state.sessionsDiscovered,
  sessionsAttempted: state.sessionsAttempted,
  sessionsVerified: state.sessionsVerified,
  providers: sortedProviders(),
  writes: state.writes,
  preflight: state.preflight,
  errors: error === undefined
    ? {
        count: 0,
        distinct: 0,
        returned: 0,
        truncated: false,
        failures: [],
      }
    : {
        count: 1,
        distinct: 1,
        returned: 1,
        truncated: false,
        failures: [{
          ...descriptor(error),
          count: 1,
        }],
      },
});

const writeReport = (value: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

const loopbackOrigin = (raw: string): URL => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw violation("arguments", "server_url_invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
    || (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !loopback
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
  ) {
    throw violation("arguments", "server_must_be_loopback_origin");
  }
  return new URL(parsed.origin);
};

const walBytes = (dbPath: string): number => {
  try {
    return statSync(`${dbPath}-wal`).size;
  } catch (error) {
    if (
      isRecord(error)
      && error.code === "ENOENT"
    ) {
      return 0;
    }
    throw violation("wal", `wal_stat_failed:${errorInput(error)}`);
  }
};

const fetchJson = async (
  url: URL,
  init: RequestInit | undefined,
  stage: ProofStage,
  provider: string,
): Promise<{ readonly status: number; readonly body: unknown }> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw violation(stage, `fetch_failed:${errorInput(error)}`, provider);
  }
  if (!response.ok) {
    throw violation(stage, `http_status:${response.status}`, provider);
  }
  try {
    return {
      status: response.status,
      body: JSON.parse(await response.text()) as unknown,
    };
  } catch (error) {
    throw violation(stage, `invalid_json:${errorInput(error)}`, provider);
  }
};

const verifyHealthTarget = async (
  server: URL,
  dbPath: string,
): Promise<void> => {
  const { status, body } = await fetchJson(
    new URL("/health", server),
    undefined,
    "health",
    "unknown",
  );
  if (
    status !== 200
    || !isRecord(body)
    || body.ok !== true
    || body.command !== "health"
    || !isRecord(body.data)
    || typeof body.data.sqlite !== "string"
  ) {
    throw violation("health", "invalid_health_envelope");
  }
  state.preflight.targetMatched = resolve(body.data.sqlite) === dbPath;
  if (!state.preflight.targetMatched) {
    throw violation("target", "health_sqlite_mismatch");
  }
};

const verifyQuiescentServer = async (server: URL): Promise<void> => {
  const { status, body } = await fetchJson(
    new URL("/status", server),
    undefined,
    "status",
    "unknown",
  );
  if (
    status !== 200
    || !isRecord(body)
    || body.ok !== true
    || body.command !== "status"
    || !isRecord(body.data)
    || !isRecord(body.data.queue)
    || !isRecord(body.data.ingest)
    || !isNonNegativeInt(body.data.queue.pending)
    || !isNonNegativeInt(body.data.queue.leased)
    || !isNonNegativeInt(body.data.queue.failed)
    || !isNonNegativeInt(body.data.ingest.activeRuns)
  ) {
    throw violation("status", "invalid_status_envelope");
  }
  const queue = {
    pending: body.data.queue.pending,
    leased: body.data.queue.leased,
    failed: body.data.queue.failed,
  };
  state.preflight.queue = queue;
  state.preflight.activeIngestRuns = body.data.ingest.activeRuns;
  if (queue.pending !== 0 || queue.leased !== 0 || queue.failed !== 0) {
    throw violation(
      "status",
      `queue_not_quiescent:${queue.pending}:${queue.leased}:${queue.failed}`,
    );
  }
  if (body.data.ingest.activeRuns !== 0) {
    throw violation(
      "status",
      `active_ingest_runs:${body.data.ingest.activeRuns}`,
    );
  }
};

const inspectCheckpoint = (dbPath: string): void => {
  let database: Database | undefined;
  try {
    database = new Database(
      `${pathToFileURL(dbPath).href}?immutable=1`,
      { readonly: true },
    );
    const applying = database.query(
      "SELECT COUNT(*) AS count FROM sessions WHERE source_fingerprint LIKE 'applying:%'",
    ).get() as { readonly count: number } | null;
    const applyingCount = Number(applying?.count);
    if (!isNonNegativeInt(applyingCount)) {
      throw violation("preflight", "invalid_applying_fingerprint_count");
    }
    state.preflight.applyingFingerprints = applyingCount;
    if (applyingCount !== 0) {
      throw violation(
        "preflight",
        `applying_fingerprints_present:${applyingCount}`,
      );
    }

    const providerRows = database.query(
      "SELECT provider, COUNT(*) AS count FROM sessions GROUP BY provider ORDER BY provider",
    ).all() as Array<{ readonly provider: string; readonly count: number }>;
    for (const row of providerRows) {
      const count = Number(row.count);
      if (
        typeof row.provider !== "string"
        || row.provider.trim() === ""
        || !isNonNegativeInt(count)
      ) {
        throw violation("preflight", "invalid_provider_aggregate");
      }
      state.providers.set(row.provider, {
        sessions: count,
        attempted: 0,
        skipped: 0,
      });
      state.sessionsDiscovered += count;
    }
  } catch (error) {
    if (error instanceof ReplayProofViolation) throw error;
    throw violation("preflight", `database_inspection_failed:${errorInput(error)}`);
  } finally {
    database?.close();
  }
};

const verifySkipOutcome = (
  body: unknown,
  status: number,
  expectedSessionId: string,
  provider: string,
): void => {
  if (
    status !== 200
    || !isRecord(body)
    || body.ok !== true
    || body.command !== "ingest/session"
    || !isRecord(body.data)
    || !isRecord(body.data.outcome)
  ) {
    throw violation("response", "invalid_ingest_envelope", provider);
  }
  const outcome = body.data.outcome;
  if (
    typeof outcome.sessionId !== "string"
    || !isNonNegativeInt(outcome.messagesWritten)
    || !isNonNegativeInt(outcome.toolCallsWritten)
    || !isNonNegativeInt(outcome.jobsEnqueued)
  ) {
    throw violation("response", "invalid_ingest_outcome", provider);
  }

  state.writes.messages += outcome.messagesWritten;
  state.writes.toolCalls += outcome.toolCallsWritten;
  state.writes.jobs += outcome.jobsEnqueued;

  if (
    outcome.sessionId !== expectedSessionId
    || outcome.status !== "skipped"
    || outcome.diagnostic !== "unchanged_source_fingerprint"
    || outcome.messagesWritten !== 0
    || outcome.toolCallsWritten !== 0
    || outcome.jobsEnqueued !== 0
  ) {
    throw violation(
      "response",
      [
        "unexpected_ingest_outcome",
        String(outcome.status),
        String(outcome.diagnostic),
        outcome.messagesWritten,
        outcome.toolCallsWritten,
        outcome.jobsEnqueued,
        outcome.sessionId === expectedSessionId ? "matching_session" : "wrong_session",
      ].join(":"),
      provider,
    );
  }
};

const replayStoredSessions = (
  server: URL,
  token: string,
): Effect.Effect<void, ReplayProofViolation, LocalStore> =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const sessionIds = yield* store.querySessionIds({}).pipe(
      Effect.mapError((error) =>
        violation("read", `query_session_ids_failed:${errorInput(error)}`)
      ),
    );
    if (sessionIds.length !== state.sessionsDiscovered) {
      return yield* Effect.fail(
        violation(
          "read",
          `session_count_mismatch:${state.sessionsDiscovered}:${sessionIds.length}`,
        ),
      );
    }

    for (const sessionId of sessionIds) {
      const mapped = yield* store.readMappedSession(sessionId).pipe(
        Effect.mapError((error) =>
          violation("read", `read_mapped_session_failed:${errorInput(error)}`)
        ),
      );
      if (mapped === undefined) {
        return yield* Effect.fail(
          violation("read", "stored_session_disappeared"),
        );
      }
      const provider = mapped.session.provider;
      const providerCounts = state.providers.get(provider);
      if (providerCounts === undefined) {
        return yield* Effect.fail(
          violation("read", "provider_aggregate_mismatch", provider),
        );
      }

      state.sessionsAttempted += 1;
      providerCounts.attempted += 1;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchJson(
            new URL("/ingest/session", server),
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-quasar-ingest-token": token,
              },
              body: JSON.stringify({ session: mapped }),
            },
            "post",
            provider,
          ),
        catch: (error) =>
          error instanceof ReplayProofViolation
            ? error
            : violation("post", `request_failed:${errorInput(error)}`, provider),
      });
      yield* Effect.try({
        try: () =>
          verifySkipOutcome(
            response.body,
            response.status,
            mapped.session.sessionId,
            provider,
          ),
        catch: (error) =>
          error instanceof ReplayProofViolation
            ? error
            : violation(
                "response",
                `outcome_check_failed:${errorInput(error)}`,
                provider,
              ),
      });
      state.sessionsVerified += 1;
      providerCounts.skipped += 1;
    }
  });

const main = async (): Promise<void> => {
  if (args.includes("--help")) {
    usage();
    return;
  }

  const dbArgument = valueFor("--db");
  if (dbArgument === undefined || dbArgument.trim() === "") {
    throw violation("arguments", "missing_db");
  }
  const serverArgument = valueFor("--server");
  if (serverArgument === undefined || serverArgument.trim() === "") {
    throw violation("arguments", "missing_server");
  }
  const token = process.env.QUASAR_INGEST_TOKEN?.trim();
  if (token === undefined || token === "") {
    throw violation("arguments", "missing_ingest_token");
  }

  const dbPath = resolve(dbArgument);
  const server = loopbackOrigin(serverArgument);
  state.preflight.walBytes = walBytes(dbPath);
  if (state.preflight.walBytes !== 0) {
    throw violation(
      "wal",
      `database_has_uncheckpointed_wal:${state.preflight.walBytes}`,
    );
  }

  await verifyHealthTarget(server, dbPath);
  await verifyQuiescentServer(server);
  inspectCheckpoint(dbPath);
  const replayResult = await Effect.runPromise(
    replayStoredSessions(server, token).pipe(
      Effect.match({
        onFailure: (error) => ({ ok: false as const, error }),
        onSuccess: () => ({ ok: true as const }),
      }),
      Effect.provide(makeReadonlyLocalStoreLayer(dbPath)),
    ),
  );
  if (!replayResult.ok) throw replayResult.error;
};

try {
  await main();
  if (!args.includes("--help")) writeReport(report(true));
} catch (error) {
  writeReport(report(false, error));
  process.exitCode = 1;
}
