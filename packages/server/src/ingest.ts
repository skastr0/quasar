import { Effect } from "effect";

import { embeddingProfileFromEnv, embeddingProfileJobNamespace } from "./embeddingProfiles";
import type { MappedSession, MessageRow } from "./model";
import { isSemanticSearchDocument, summarizeSearchDocumentPolicy, type SearchDocumentPolicyStats } from "./searchPolicy";
import { DurableQueue, type DurableQueueService } from "./services";
import { LocalStore } from "./store";

export type SessionIngestStatus = "ok" | "skipped" | "failed";

export interface SessionIngestOutcome {
  readonly sessionId: string;
  readonly status: SessionIngestStatus;
  readonly diagnostic?: string;
  readonly detail?: string;
  /** Row-delta counts: inserted + updated rows only. Unchanged rows of a
   * re-sent session are never written and never counted. */
  readonly messagesWritten: number;
  readonly toolCallsWritten: number;
  readonly jobsEnqueued: number;
  readonly searchDocuments?: SearchDocumentPolicyStats;
  readonly delta?: {
    readonly messagesDeleted: number;
    readonly messagesUnchanged: number;
    readonly toolCallsDeleted: number;
    readonly toolCallsUnchanged: number;
  };
}

const EMBEDDING_JOB_MAX_ATTEMPTS = 12;

export const enqueueDownstreamJobs = (queue: DurableQueueService, rows: readonly MessageRow[]): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const embeddingJobNamespace = embeddingProfileJobNamespace(embeddingProfileFromEnv());
    const embeddingMaxAttempts = EMBEDDING_JOB_MAX_ATTEMPTS;
    const messages = rows.filter(isSemanticSearchDocument);
    yield* queue.enqueueBatch(messages.map((message) => ({
      kind: "embed-message",
      payload: {
        sessionId: message.sessionId,
        seq: message.seq,
        role: message.role,
        projectKey: message.projectKey,
        contentHash: message.contentHash,
        embeddingProfile: embeddingJobNamespace,
      },
      idempotencyKey: `embed-message:${embeddingJobNamespace}:${message.sessionId}:${message.seq}:${message.contentHash}`,
      maxAttempts: embeddingMaxAttempts,
    })));
    return messages.length;
  });

export const ingestMappedSession = (
  mapped: MappedSession,
  options: { readonly force?: boolean } = {},
): Effect.Effect<SessionIngestOutcome, unknown, LocalStore | DurableQueue> =>
  Effect.gen(function* () {
    const store = yield* LocalStore;
    const queue = yield* DurableQueue;
    const unchanged = options.force === true
      ? false
      : yield* store.hasSessionFingerprint(
        mapped.session.sessionId,
        mapped.session.sourceFingerprint,
        mapped.session.normalizationVersion,
      ).pipe(Effect.catchAll(() => Effect.succeed(false)));
    if (unchanged) {
      return {
        sessionId: mapped.session.sessionId,
        status: "skipped" as const,
        diagnostic: "unchanged_source_fingerprint",
        messagesWritten: 0,
        toolCallsWritten: 0,
        jobsEnqueued: 0,
      };
    }
    const diff = yield* store.upsertSession(mapped);
    // A prior interrupted apply may have written rows before its queue fan-out
    // failed. Replay every desired job in that case; queue idempotency collapses
    // any jobs that were already durable. Ordinary applies stay row-delta-only.
    // `force` keeps its repair meaning even when no row changed.
    const embedTargets = options.force === true || diff.requiresDownstreamReplay
      ? mapped.messages
      : diff.changedMessages;
    const jobsEnqueued = yield* enqueueDownstreamJobs(queue, embedTargets);
    yield* store.finalizeSessionIngest(
      mapped.session.sessionId,
      mapped.session.sourceFingerprint,
      mapped.session.normalizationVersion,
    );
    return {
      sessionId: mapped.session.sessionId,
      status: "ok" as const,
      messagesWritten: diff.messagesInserted + diff.messagesUpdated,
      toolCallsWritten: diff.toolCallsInserted + diff.toolCallsUpdated,
      jobsEnqueued,
      searchDocuments: summarizeSearchDocumentPolicy(mapped.messages),
      delta: {
        messagesDeleted: diff.messagesDeleted,
        messagesUnchanged: diff.messagesUnchanged,
        toolCallsDeleted: diff.toolCallsDeleted,
        toolCallsUnchanged: diff.toolCallsUnchanged,
      },
    };
  }).pipe(
    Effect.withSpan("ingest.session", {
      attributes: { sessionId: mapped.session.sessionId },
    }),
  );
