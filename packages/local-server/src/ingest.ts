import { statSync } from "node:fs";

import {
  adaptersByProvider,
  loadMachineIdentity,
  sourceFingerprintFor,
  stableAdapters,
  type Provider,
} from "@skastr0/quasar-core";
import { Effect } from "effect";

import { embeddingProfileFromEnv, embeddingProfileJobNamespace } from "./embeddingProfiles";
import { mapSession } from "./map";
import type { MappedSession, MessageRow } from "./model";
import { isSemanticSearchDocument, summarizeSearchDocumentPolicy, type SearchDocumentPolicyStats } from "./searchPolicy";
import { DurableQueue, type DurableQueueService } from "./services";
import { LocalStore } from "./store";

export interface IngestOptions {
  readonly provider: Provider | "all";
  readonly limit?: number;
  readonly force?: boolean;
}

const providerRootEnv: Partial<Record<Provider, string>> = {
  codex: "QUASAR_CODEX_ROOT",
  claude: "QUASAR_CLAUDE_ROOT",
  opencode: "QUASAR_OPENCODE_ROOT",
  grok: "QUASAR_GROK_ROOT",
  hermes: "QUASAR_HERMES_ROOT",
  kimi: "QUASAR_KIMI_ROOT",
  antigravity: "QUASAR_ANTIGRAVITY_ROOT",
};

const configuredRoots = (): Partial<Record<Provider, string>> => {
  const roots: Partial<Record<Provider, string>> = {};
  for (const [provider, envName] of Object.entries(providerRootEnv) as [Provider, string][]) {
    const value = process.env[envName]?.trim();
    if (value !== undefined && value.length > 0) roots[provider] = value;
  }
  return roots;
};

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

export interface IngestReport {
  readonly provider: string;
  readonly sessionsSeen: number;
  readonly sessionsWritten: number;
  readonly sessionsSkipped: number;
  readonly sessionsFailed: number;
  readonly messagesWritten: number;
  readonly toolCallsWritten: number;
  readonly jobsEnqueued: number;
  readonly searchDocuments: SearchDocumentPolicyStats;
  readonly outcomes: readonly SessionIngestOutcome[];
  readonly failures: readonly { readonly sessionId: string; readonly diagnostic: string; readonly error: string }[];
  readonly durationMs: number;
}

const fingerprintForItem = (item: {
  readonly fingerprint?: unknown;
  readonly sourceUnit?: { readonly physicalPath?: string };
  readonly session: { readonly sourcePath: string };
}): string => {
  if (item.fingerprint !== undefined) return JSON.stringify(item.fingerprint);
  const path = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
  return sourceFingerprintFor(statSync(path));
};

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const positiveIntEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const searchableMessages = (session: MappedSession): readonly MessageRow[] =>
  session.messages.filter(isSemanticSearchDocument);

const enqueueDownstreamJobs = (queue: DurableQueueService, session: MappedSession): Effect.Effect<number, unknown> =>
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
          idempotencyKey: `embed-message:${embeddingJobNamespace}:${message.contentHash}`,
          maxAttempts: embeddingMaxAttempts,
        }),
      { concurrency: 16 },
    );
    return 1 + messages.length;
  });

const ingestProvider = (provider: Provider, options: IngestOptions): Effect.Effect<IngestReport, never, LocalStore | DurableQueue> =>
  Effect.gen(function* () {
    const startedAt = Date.now();
    const adapter = adaptersByProvider.get(provider);
    const store = yield* LocalStore;
    const queue = yield* DurableQueue;
    if (adapter?.stream === undefined) {
      return {
        provider,
        sessionsSeen: 0,
        sessionsWritten: 0,
        sessionsSkipped: 0,
        sessionsFailed: 1,
        messagesWritten: 0,
        toolCallsWritten: 0,
        jobsEnqueued: 0,
        searchDocuments: { total: 0, semanticEligible: 0, ignored: 0 },
        outcomes: [
          {
            sessionId: provider,
            status: "failed",
            diagnostic: "provider_stream_unavailable",
            detail: `Provider ${provider} does not expose a stream`,
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          },
        ],
        failures: [{ sessionId: provider, diagnostic: "provider_stream_unavailable", error: `Provider ${provider} does not expose a stream` }],
        durationMs: Date.now() - startedAt,
      };
    }

    let sessionsSeen = 0;
    let sessionsWritten = 0;
    let sessionsSkipped = 0;
    let sessionsFailed = 0;
    let messagesWritten = 0;
    let toolCallsWritten = 0;
    let jobsEnqueued = 0;
    let semanticEligible = 0;
    let ignored = 0;
    const outcomes: SessionIngestOutcome[] = [];
    const failures: { sessionId: string; diagnostic: string; error: string }[] = [];

    const stream = adapter.stream({
      machine: loadMachineIdentity(),
      now: new Date().toISOString(),
      roots: configuredRoots(),
      limit: options.limit,
    });

    yield* Effect.promise(async () => {
      for await (const item of stream) {
        if (item.type !== "session") continue;
        sessionsSeen += 1;
        let sourceFingerprint: string;
        try {
          sourceFingerprint = fingerprintForItem(item);
        } catch (error) {
          sessionsFailed += 1;
          const detail = errorMessage(error);
          outcomes.push({
            sessionId: item.session.id,
            status: "failed",
            diagnostic: "source_fingerprint_failed",
            detail,
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          });
          failures.push({ sessionId: item.session.id, diagnostic: "source_fingerprint_failed", error: detail });
          continue;
        }
        const unchanged = await Effect.runPromise(
          store.hasSessionFingerprint(item.session.id, sourceFingerprint).pipe(
            Effect.catchAll(() => Effect.succeed(false)),
          ),
        );
        if (unchanged && options.force !== true) {
          sessionsSkipped += 1;
          outcomes.push({
            sessionId: item.session.id,
            status: "skipped",
            diagnostic: "unchanged_source_fingerprint",
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          });
          continue;
        }
        let mapped: MappedSession;
        try {
          mapped = mapSession(item.session, sourceFingerprint);
        } catch (error) {
          sessionsFailed += 1;
          const detail = errorMessage(error);
          outcomes.push({
            sessionId: item.session.id,
            status: "failed",
            diagnostic: "map_session_failed",
            detail,
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          });
          failures.push({ sessionId: item.session.id, diagnostic: "map_session_failed", error: detail });
          continue;
        }
        const result = await Effect.runPromise(
          store.upsertSession(mapped).pipe(
            Effect.zipRight(enqueueDownstreamJobs(queue, mapped)),
            Effect.either,
          ),
        );
        if (result._tag === "Left") {
          sessionsFailed += 1;
          const detail = errorMessage(result.left);
          outcomes.push({
            sessionId: item.session.id,
            status: "failed",
            diagnostic: "write_or_enqueue_failed",
            detail,
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          });
          failures.push({ sessionId: item.session.id, diagnostic: "write_or_enqueue_failed", error: detail });
          continue;
        }
        sessionsWritten += 1;
        messagesWritten += mapped.messages.length;
        toolCallsWritten += mapped.toolCalls.length;
        const searchDocuments = summarizeSearchDocumentPolicy(mapped.messages);
        semanticEligible += searchDocuments.semanticEligible;
        ignored += searchDocuments.ignored;
        jobsEnqueued += result.right;
        outcomes.push({
          sessionId: item.session.id,
          status: "ok",
          messagesWritten: mapped.messages.length,
          toolCallsWritten: mapped.toolCalls.length,
          jobsEnqueued: result.right,
          searchDocuments,
        });
      }
    });

    return {
      provider,
      sessionsSeen,
      sessionsWritten,
      sessionsSkipped,
      sessionsFailed,
      messagesWritten,
      toolCallsWritten,
      jobsEnqueued,
      searchDocuments: {
        total: messagesWritten,
        semanticEligible,
        ignored,
      },
      outcomes,
      failures,
      durationMs: Date.now() - startedAt,
    };
  });

export const ingest = (options: IngestOptions): Effect.Effect<readonly IngestReport[], never, LocalStore | DurableQueue> => {
  const providers =
    options.provider === "all"
      ? stableAdapters.map((adapter) => adapter.provider).filter((provider) => provider !== "amp")
      : [options.provider];
  return Effect.forEach(providers, (provider) => ingestProvider(provider, options), { concurrency: 1 });
};
