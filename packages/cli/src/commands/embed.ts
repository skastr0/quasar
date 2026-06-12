import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import { createConvexClient, withRetry } from "../convex-client";
import { executeJsonCommand } from "../output";

/**
 * Published Gemini embedding price: $0.15 per 1M input tokens. Used only to
 * report absolute-dollar spend from measured token counts — never to gate or
 * budget the run.
 */
const GEMINI_EMBEDDING_USD_PER_MILLION_TOKENS = 0.15;

/** Sessions per embedQueue page while walking the backfill queue. */
const QUEUE_PAGE = 200;

/** Progress line cadence (sessions). */
const PROGRESS_EVERY = 25;

export interface EmbedRunReport {
  readonly sessionsScanned: number;
  readonly sessionsPending: number;
  readonly sessionsEmbedded: number;
  readonly sessionsSkipped: number;
  readonly sessionsSuperseded: number;
  readonly sessionsIngestClaimed: number;
  readonly messagesEmbedded: number;
  readonly messagesReused: number;
  readonly chunksEmbedded: number;
  readonly tokens: number;
  readonly tokensEstimated: boolean;
  readonly pricePerMillionTokensUSD: number;
  readonly estimatedSpendUSD: number;
  readonly durationMs: number;
  /** Sessions whose embed action failed; embed state is per-session, so a
   * rerun retries exactly these. The run aborts only on systemic failure
   * (several consecutive errors). */
  readonly failures: readonly { readonly sessionId: string; readonly error: string }[];
  /** Present when the run aborted on consecutive failures. */
  readonly error?: string;
}

/** Consecutive per-session failures that indicate a systemic problem (key,
 * backend, network) rather than one bad session — abort instead of burning
 * through the whole queue. */
const ABORT_AFTER_CONSECUTIVE_FAILURES = 5;

const spendUSD = (tokens: number): number =>
  Math.round((tokens / 1_000_000) * GEMINI_EMBEDDING_USD_PER_MILLION_TOKENS * 10_000) /
  10_000;

const progressLine = (done: number, total: number, tokens: number) => {
  process.stderr.write(
    `embed: ${done}/${total} sessions, ${tokens} tokens (~$${spendUSD(tokens).toFixed(4)})\n`,
  );
};

const runEmbed = async (options: {
  readonly limit?: number;
  readonly force?: boolean;
}): Promise<EmbedRunReport> => {
  const startedAt = Date.now();
  const client = createConvexClient();

  // Walk the full queue first: cheap (a few session pages), and it lets the
  // report speak absolute numbers about the whole estate.
  const candidates: string[] = [];
  let sessionsScanned = 0;
  let sessionsIngestClaimed = 0;
  let cursor: string | null = null;
  do {
    const page = await withRetry(() =>
      client.query(api.embed.embedQueue, {
        paginationOpts: { numItems: QUEUE_PAGE, cursor },
      }),
    );
    for (const row of page.page) {
      sessionsScanned += 1;
      if (row.ingestClaimed) {
        sessionsIngestClaimed += 1;
        continue;
      }
      if (row.pending || options.force === true) candidates.push(row.sessionId);
    }
    cursor = page.isDone ? null : page.continueCursor;
  } while (cursor !== null);

  const sessionsPending = candidates.length;
  const toEmbed =
    options.limit !== undefined ? candidates.slice(0, options.limit) : candidates;

  let sessionsEmbedded = 0;
  let sessionsSkipped = 0;
  let sessionsSuperseded = 0;
  let messagesEmbedded = 0;
  let messagesReused = 0;
  let chunksEmbedded = 0;
  let tokens = 0;
  let tokensEstimated = false;
  const failures: { sessionId: string; error: string }[] = [];
  let consecutiveFailures = 0;
  let runError: string | undefined;

  let done = 0;
  for (const sessionId of toEmbed) {
    try {
      const report = await withRetry(() =>
        client.action(api.embed.embedSession, {
          sessionId,
          ...(options.force === true ? { force: true } : {}),
        }),
      );
      if (report.status === "embedded") sessionsEmbedded += 1;
      else if (report.status === "superseded") sessionsSuperseded += 1;
      else sessionsSkipped += 1;
      messagesEmbedded += report.messagesEmbedded;
      messagesReused += report.messagesReused;
      chunksEmbedded += report.chunksEmbedded;
      tokens += report.tokens;
      tokensEstimated = tokensEstimated || report.tokensEstimated;
      consecutiveFailures = 0;
    } catch (error) {
      // One failing session must not lose the rest of the estate; embed
      // state is per-session, so a rerun retries exactly the failures.
      const message = error instanceof Error ? error.message : String(error);
      failures.push({ sessionId, error: message });
      process.stderr.write(`embed: FAILED ${sessionId}: ${message}\n`);
      consecutiveFailures += 1;
      if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE_FAILURES) {
        runError = `aborted after ${consecutiveFailures} consecutive session failures (systemic); last: ${message}`;
        break;
      }
    }
    done += 1;
    if (done % PROGRESS_EVERY === 0 || done === toEmbed.length) {
      progressLine(done, toEmbed.length, tokens);
    }
  }

  return {
    sessionsScanned,
    sessionsPending,
    sessionsEmbedded,
    sessionsSkipped,
    sessionsSuperseded,
    sessionsIngestClaimed,
    messagesEmbedded,
    messagesReused,
    chunksEmbedded,
    tokens,
    tokensEstimated,
    pricePerMillionTokensUSD: GEMINI_EMBEDDING_USD_PER_MILLION_TOKENS,
    estimatedSpendUSD: spendUSD(tokens),
    durationMs: Date.now() - startedAt,
    failures,
    ...(runError !== undefined ? { error: runError } : {}),
  };
};

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Embed at most this many pending sessions this run"),
  Options.optional,
);
const forceOption = Options.boolean("force").pipe(
  Options.withDescription(
    "Re-walk sessions even when their embedded fingerprint is current (unchanged rows are reused by content hash, not re-billed)",
  ),
);

export const embedCommand = Command.make(
  "embed",
  { limit: limitOption, force: forceOption },
  ({ limit, force }) =>
    executeJsonCommand(
      "embed",
      Effect.tryPromise({
        try: () => runEmbed({ limit: Option.getOrUndefined(limit), force }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    ),
);
