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
  readonly messagesWritten: number;
  readonly toolCallsWritten: number;
  readonly jobsEnqueued: number;
  readonly searchDocuments?: SearchDocumentPolicyStats;
}

const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const searchableMessages = (session: MappedSession): readonly MessageRow[] =>
  session.messages.filter(isSemanticSearchDocument);

export const enqueueDownstreamJobs = (queue: DurableQueueService, session: MappedSession): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const embeddingJobNamespace = embeddingProfileJobNamespace(embeddingProfileFromEnv());
    const embeddingMaxAttempts = positiveIntEnv("QUASAR_EMBEDDING_JOB_MAX_ATTEMPTS", 12);
    const messages = searchableMessages(session);
    yield* queue.enqueue({
      kind: "index-session",
      payload: {
        sessionId: session.session.sessionId,
        projectKey: session.session.projectKey,
        sourceFingerprint: session.session.sourceFingerprint,
      },
      idempotencyKey: `index-session:${session.session.sessionId}`,
    });
    yield* Effect.forEach(
      messages,
      (message) =>
        queue.enqueue({
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
        }),
      { concurrency: 16 },
    );
    return 1 + messages.length;
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
    const jobsEnqueued = yield* store.upsertSession(mapped).pipe(
      Effect.zipRight(enqueueDownstreamJobs(queue, mapped)),
    );
    return {
      sessionId: mapped.session.sessionId,
      status: "ok" as const,
      messagesWritten: mapped.messages.length,
      toolCallsWritten: mapped.toolCalls.length,
      jobsEnqueued,
      searchDocuments: summarizeSearchDocumentPolicy(mapped.messages),
    };
  });
