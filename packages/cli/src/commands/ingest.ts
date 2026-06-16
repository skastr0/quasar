import { statSync } from "node:fs";

import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import {
  adaptersByProvider,
  loadMachineIdentity,
  redactSensitive,
  sourceFingerprintFor,
  type ContentBlock,
  type NormalizedSession,
  type Provider,
  type SessionEvent,
} from "@skastr0/quasar-core";

import { createConvexClient, withRetry } from "../convex-client";
import { CommandInputError } from "../errors";
import { openIngestLedger } from "../ingest-ledger";
import { executeJsonCommand } from "../output";

/**
 * Convex's 1 MiB value limit, adopted wholesale as the boundary-rejection
 * line: a string value must be smaller than 1 MiB when UTF-8 encoded. The
 * measured corpus has no legitimate session value over 185 KB, so anything at
 * or beyond the platform limit is provider garbage: named diagnostic
 * (provider, sessionId, field, observedBytes), zero rows written for it, run
 * continues. Never truncate, never clamp, never invent a smaller budget.
 */
const CONVEX_MAX_VALUE_BYTES = 1_048_576;

/** Rows per insert mutation — small, instantly-completing mutations. */
const INSERT_BATCH = 250;

export type MessageRole = "user" | "assistant" | "reasoning";

export interface MessageRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly ts?: string;
  readonly projectKey: string;
}

export interface ToolCallRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly toolName: string;
  readonly status?: string;
  readonly inputText: string;
  readonly outputText: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly projectKey: string;
  readonly provider: string;
}

export interface IngestDiagnostic {
  readonly provider: string;
  readonly sessionId: string;
  readonly field: string;
  readonly observedBytes: number;
}

export interface MappedSession {
  readonly project: {
    readonly projectKey: string;
    readonly displayName: string;
    readonly aliases: readonly string[];
    readonly rawPaths: readonly string[];
  };
  readonly session: {
    readonly sessionId: string;
    readonly projectKey: string;
    readonly provider: string;
    readonly agentName: string;
    readonly title?: string;
    readonly startedAt?: string;
    readonly updatedAt?: string;
    readonly sourcePath: string;
    readonly messageCount: number;
    readonly toolCallCount: number;
  };
  readonly messages: readonly MessageRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly diagnostics: readonly IngestDiagnostic[];
  /** UTF-8 bytes of every admitted text value — the basis for approxMBWritten. */
  readonly bytesAdmitted: number;
}

export interface IngestReport {
  readonly provider: string;
  readonly sessionsWritten: number;
  readonly sessionsSkipped: number;
  readonly messages: number;
  readonly toolCalls: number;
  readonly diagnostics: readonly IngestDiagnostic[];
  readonly durationMs: number;
  readonly approxMBWritten: number;
  /** Present when the provider's run aborted: counts are zero, sessions
   * already committed before the abort stay in the backend (idempotent). */
  readonly error?: string;
}

export interface AllIngestReport {
  readonly providers: readonly IngestReport[];
  readonly totalSessionsWritten: number;
  readonly totalSessionsSkipped: number;
  readonly totalMessages: number;
  readonly totalToolCalls: number;
  readonly totalDiagnostics: number;
  readonly totalDurationMs: number;
  readonly totalApproxMBWritten: number;
}

const redactText = (value: string): string => redactSensitive(value) as string;

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Stringify a projected tool payload faithfully: adapter payloads are already
 * JSON-safe NativeValues (string, object, array) or truncation envelopes.
 * Strings pass through verbatim; everything else is canonical JSON.
 */
const stringifyToolPayload = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? "";
};

/**
 * Native block types whose fallback `text` rendering is agent machinery, not
 * session text: empty-thinking stubs (`{"type":"thinking"}`) and the JSON
 * renderings of tool_use/tool_result blocks (those live in `toolCalls`).
 */
const MACHINERY_NATIVE_TYPES = new Set(["thinking", "tool_use", "tool_result"]);

/**
 * Event kinds that are injected machinery even when they carry a user or
 * assistant role: wrappers and permissions preambles (`preamble`), provider
 * system records (`system`), and compaction summaries (`summary`). No human
 * authored them, so they never become `messages` rows.
 */
const INJECTED_EVENT_KINDS = new Set(["preamble", "system", "summary"]);

const nativeTypeOf = (block: ContentBlock): string | undefined => {
  if (block.metadata === null || typeof block.metadata !== "object") return undefined;
  const nativeType = (block.metadata as Record<string, unknown>).nativeType;
  return typeof nativeType === "string" ? nativeType : undefined;
};

const blockText = (block: ContentBlock): string | undefined => {
  if (MACHINERY_NATIVE_TYPES.has(nativeTypeOf(block) ?? "")) return undefined;
  if (block.kind === "text") return block.text;
  if (block.kind === "markdown") return block.markdown;
  return undefined;
};

const blockThinking = (block: ContentBlock): string | undefined =>
  block.kind === "thinking" &&
  block.thinking !== undefined &&
  block.thinking.trim().length > 0
    ? block.thinking
    : undefined;

/**
 * Per-provider mapping hooks for the provider-generic engine. The shared
 * mapper owns only normalized types; everything a hook decides is provider
 * knowledge (which normalized events are admissible message sources).
 */
export interface ProviderIngestHooks {
  /**
   * Gate on normalized events before message mapping. Returning false skips
   * the event for `messages`; `toolCalls` are mapped from the adapter's
   * ToolCall records and are unaffected.
   */
  readonly admitMessageEvent?: (event: SessionEvent) => boolean;
  /**
   * Source-row garbage line. Returning a rejection marks the event's raw
   * source row as provider garbage: the engine emits the named diagnostic
   * `(provider, sessionId, field, observedBytes)` and writes zero rows for
   * the event — no messages and no toolCalls. Used when an adapter-side
   * pruning guard removes the bulk before this process ever sees it, so the
   * post-prune value cannot witness the breach itself.
   */
  readonly rejectEvent?: (
    event: SessionEvent,
  ) => { readonly field: string; readonly observedBytes: number } | undefined;
}

/**
 * Codex: `response_item` records are the canonical surface — `event_msg`
 * rows duplicate the same content (18.7 MB measured) and are never ingested.
 * Only `kind: "message"` events become messages rows: codex function_call /
 * custom_tool_call events carry JSON tool payloads as their fallback text,
 * and tool payloads belong to `toolCalls` only, never the search surface.
 * Encrypted/summarized reasoning carries `role: "thinking"` and is already
 * excluded by the shared role gate. Injected wrappers arrive as
 * `kind: "preamble"` from the adapter and are excluded by the shared
 * injected-kind gate.
 */
const codexHooks: ProviderIngestHooks = {
  admitMessageEvent: (event) =>
    event.kind === "message" &&
    event.rawReference.nativeType?.startsWith("response_item") === true,
};

/**
 * Opencode: text/reasoning/tool parts arrive already classified by the
 * adapter (reasoning as thinking blocks, machinery parts dropped, tool parts
 * tagged tool_use). The one provider-specific line: the adapter's SQL pruning
 * guard strips machinery keys (`summary.diffs` et al.) inside SQLite, so a
 * garbage source row — the measured corpus holds one 105 MB `message.data`
 * blob — would otherwise vanish silently. The adapter reports the pre-prune
 * byte length on `rawReference.rawBytes`; any row at or beyond the Convex
 * value limit is provider garbage: named diagnostic, zero rows, continue.
 */
const opencodeHooks: ProviderIngestHooks = {
  rejectEvent: (event) => {
    const rawBytes = event.rawReference.rawBytes;
    return rawBytes !== undefined && rawBytes >= CONVEX_MAX_VALUE_BYTES
      ? { field: "message.data", observedBytes: rawBytes }
      : undefined;
  },
};

/**
 * Hermes: sessions and messages tables only; FTS tables and session_meta rows
 * are filtered at the adapter level. No source-row garbage lines exist in the
 * hermes corpus (all values well within Convex limits); plain admission.
 */
const hermesHooks: ProviderIngestHooks = {};

/**
 * Grok: chat_history events are the canonical turn surface. Reasoning is
 * extracted as plaintext `thinking` blocks (emitted as role: "thinking" events
 * by the adapter); tool_calls arrays on assistant events are the structural
 * surface. No oversized rows measured in the full corpus; plain admission.
 */
const grokHooks: ProviderIngestHooks = {};

const kimiHooks: ProviderIngestHooks = {};

/** Hooks per supported provider; presence in this map is the support gate. */
export const PROVIDER_INGEST_HOOKS: ReadonlyMap<Provider, ProviderIngestHooks> = new Map([
  ["claude", {}],
  ["codex", codexHooks],
  ["opencode", opencodeHooks],
  ["hermes", hermesHooks],
  ["grok", grokHooks],
  ["kimi", kimiHooks],
]);

export const SUPPORTED_INGEST_PROVIDERS = [...PROVIDER_INGEST_HOOKS.keys()];

/**
 * Maps a normalized session to Quasar rows (provider-generic engine):
 * - user/assistant text turns → `messages` rows (seq = event sequence);
 * - plaintext thinking blocks → `role: "reasoning"` rows (adapters emit
 *   them as assistant message blocks; promotion happens here);
 * - adapter ToolCall records → `toolCalls` rows with faithfully stringified
 *   input/output and seq taken from the originating tool-call event.
 * Provider specifics enter only through `hooks`. Every text passes through
 * redactSensitive, then the Convex 1 MiB boundary line.
 */
export const mapNormalizedSession = (
  session: NormalizedSession,
  hooks: ProviderIngestHooks = {},
): MappedSession => {
  const sessionId = session.id;
  const projectKey = session.projectIdentity.projectIdentityKey;
  const diagnostics: IngestDiagnostic[] = [];
  let bytesAdmitted = 0;

  const admit = (value: string, field: string): string | undefined => {
    const observedBytes = utf8Bytes(value);
    if (observedBytes >= CONVEX_MAX_VALUE_BYTES) {
      diagnostics.push({ provider: session.provider, sessionId, field, observedBytes });
      return undefined;
    }
    return value;
  };

  // Source-row garbage pass: a rejected event writes zero rows — its
  // messages and toolCalls alike — and surfaces once as a named diagnostic.
  const rejectedEventIds = new Set<string>();
  if (hooks.rejectEvent !== undefined) {
    for (const event of session.events) {
      const rejection = hooks.rejectEvent(event);
      if (rejection === undefined) continue;
      diagnostics.push({
        provider: session.provider,
        sessionId,
        field: rejection.field,
        observedBytes: rejection.observedBytes,
      });
      rejectedEventIds.add(event.id);
    }
  }

  const messages: MessageRow[] = [];
  for (const event of session.events) {
    if (rejectedEventIds.has(event.id)) continue;
    // Admit user, assistant, and thinking roles. `thinking` events are emitted
    // by adapters (e.g. grok) that produce a dedicated reasoning event rather
    // than embedding thinking blocks inside an assistant event; they map
    // directly to role: "reasoning" rows.
    if (event.role !== "user" && event.role !== "assistant" && event.role !== "thinking") continue;
    if (INJECTED_EVENT_KINDS.has(event.kind)) continue;
    if (hooks.admitMessageEvent?.(event) === false) continue;
    const reasoningParts: string[] = [];
    const textParts: string[] = [];
    if (event.role === "thinking") {
      // Dedicated reasoning event: treat contentText directly as reasoning.
      if (event.contentText !== undefined && event.contentText.trim().length > 0) {
        reasoningParts.push(event.contentText);
      }
    } else if (event.contentBlocks.length === 0) {
      // Plain-string content short-circuits block construction in the adapter.
      if (event.kind === "message" && event.contentText !== undefined) {
        textParts.push(event.contentText);
      }
    } else {
      for (const block of event.contentBlocks) {
        const thinking = blockThinking(block);
        if (thinking !== undefined) {
          reasoningParts.push(thinking);
          continue;
        }
        const text = blockText(block);
        if (text !== undefined && text.trim().length > 0) textParts.push(text);
      }
    }
    const pushRow = (role: MessageRole, parts: readonly string[]) => {
      if (parts.length === 0) return;
      const text = admit(redactText(parts.join("\n\n")), "messages.text");
      if (text === undefined) return;
      bytesAdmitted += utf8Bytes(text);
      messages.push({
        sessionId,
        seq: event.sequence,
        role,
        text,
        ...(event.timestamp !== undefined ? { ts: event.timestamp } : {}),
        projectKey,
      });
    };
    // Reasoning first so same-seq rows read in thought-then-reply order.
    pushRow("reasoning", reasoningParts);
    // `thinking` events map entirely to reasoning; their textParts are empty.
    if (event.role !== "thinking") {
      pushRow(event.role, textParts);
    }
  }

  const seqByEventId = new Map(session.events.map((event) => [event.id, event.sequence]));
  const toolCalls: ToolCallRow[] = [];
  for (const toolCall of session.toolCalls) {
    if (rejectedEventIds.has(toolCall.eventId)) continue;
    const inputText = admit(
      stringifyToolPayload(redactSensitive(toolCall.input)),
      "toolCalls.inputText",
    );
    const outputText = admit(
      stringifyToolPayload(redactSensitive(toolCall.output)),
      "toolCalls.outputText",
    );
    // Boundary rejection writes zero rows for the offending value's record.
    if (inputText === undefined || outputText === undefined) continue;
    bytesAdmitted += utf8Bytes(inputText) + utf8Bytes(outputText);
    toolCalls.push({
      sessionId,
      seq: seqByEventId.get(toolCall.eventId) ?? 0,
      toolName: toolCall.toolName,
      ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
      inputText,
      outputText,
      ...(toolCall.startedAt !== undefined ? { startedAt: toolCall.startedAt } : {}),
      ...(toolCall.completedAt !== undefined ? { completedAt: toolCall.completedAt } : {}),
      projectKey,
      provider: session.provider,
    });
  }

  const identity = session.projectIdentity;
  const title =
    session.title === undefined
      ? undefined
      : admit(redactText(session.title), "sessions.title");
  return {
    project: {
      projectKey,
      displayName: identity.displayName,
      aliases: [],
      rawPaths: [
        ...new Set(
          [identity.rawPath, identity.normalizedPath].filter(
            (path): path is string => path !== undefined,
          ),
        ),
      ],
    },
    session: {
      sessionId,
      projectKey,
      provider: session.provider,
      agentName: session.agentName,
      ...(title !== undefined ? { title } : {}),
      ...(session.startedAt !== undefined ? { startedAt: session.startedAt } : {}),
      ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
      sourcePath: session.sourcePath,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
    },
    messages,
    toolCalls,
    diagnostics,
    bytesAdmitted,
  };
};

const chunk = <T>(rows: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
};

/** The Convex mutation surface this engine drives; injectable for tests. */
export interface IngestMutationClient {
  mutation: (reference: unknown, args: unknown) => Promise<unknown>;
}

export const runProviderIngest = async (options: {
  readonly provider: string;
  readonly root?: string;
  readonly limit?: number;
  readonly force?: boolean;
  readonly reset?: boolean;
  /** Injected for tests; defaults to the live Convex client. */
  readonly client?: IngestMutationClient;
  /** Injected for tests; defaults to QUASAR_HOME. */
  readonly ledgerHome?: string;
}): Promise<IngestReport> => {
  const provider = options.provider as Provider;
  const hooks = PROVIDER_INGEST_HOOKS.get(provider);
  if (hooks === undefined) {
    throw new CommandInputError({
      field: "provider",
      message: `Unsupported ingest provider: ${options.provider}. Supported: ${SUPPORTED_INGEST_PROVIDERS.join(", ")}.`,
    });
  }
  const startedAt = Date.now();
  // Local fingerprint cache: a redundant optimization that lets an unchanged
  // session be skipped before it is parsed. The server stays the authoritative
  // idempotency gate, so a missing/stale ledger only ever costs a redundant
  // begin the server then skips. --force/--reset bypass it entirely.
  const ledger = openIngestLedger(options.ledgerHome);
  if (options.reset === true) ledger.clear();
  const client = options.client ?? createConvexClient();
  // One claim token per run: every turn mutation verifies it, so a concurrent
  // run that re-claims a session makes this run fail loudly instead of
  // interleaving duplicate rows.
  const runId = crypto.randomUUID();
  const stream = adaptersByProvider.get(provider)?.stream;
  if (stream === undefined) {
    throw new CommandInputError({
      field: "provider",
      message: `The ${provider} adapter does not expose a session stream.`,
    });
  }

  let sessionsWritten = 0;
  let sessionsSkipped = 0;
  let messagesWritten = 0;
  let toolCallsWritten = 0;
  let bytesWritten = 0;
  const diagnostics: IngestDiagnostic[] = [];

  const items = stream({
    machine: loadMachineIdentity(),
    now: new Date().toISOString(),
    ...(options.root !== undefined ? { roots: { [provider]: options.root } } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    shouldParseSession: (probe) =>
      options.force === true || options.reset === true
        ? true
        : !ledger.has(probe.sessionId, probe.sourceFingerprint),
  });

  for await (const item of items) {
    if (item.type !== "session") continue;
    const mapped = mapNormalizedSession(item.session, hooks);
    diagnostics.push(...mapped.diagnostics);

    // An adapter-provided fingerprint wins: shared-db providers (opencode,
    // hermes) report the session row's own change signal, because the db
    // file's stat changes whenever ANY session is touched. Otherwise stat the
    // per-session source file.
    let sourceFingerprint: string;
    if (item.fingerprint === undefined) {
      const physicalPath = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
      sourceFingerprint = sourceFingerprintFor(statSync(physicalPath));
    } else {
      sourceFingerprint = JSON.stringify(item.fingerprint);
    }

    await withRetry(() =>
      client.mutation(api.quasar.upsertProject, {
        ...mapped.project,
        aliases: [...mapped.project.aliases],
        rawPaths: [...mapped.project.rawPaths],
      }),
    );
    // beginSessionIngest claims the session (run-scoped token); the claim is
    // only cleared by commitSessionIngest after every turn row has landed, so
    // a crash mid-ingest leaves the session claimed and re-ingested next run.
    const begin = (await withRetry(() =>
      client.mutation(api.quasar.beginSessionIngest, {
        ...mapped.session,
        sourceFingerprint,
        runId,
        ...(options.force === true ? { force: true } : {}),
      }),
    )) as { skipped: boolean };
    if (begin.skipped) {
      // The server already holds this fingerprint: record it locally so the
      // next run skips the parse before reaching the server at all.
      ledger.record(mapped.session.sessionId, sourceFingerprint);
      sessionsSkipped += 1;
      continue;
    }

    // Drain old turns before inserting; the mutation deletes one batch per call.
    let result: { deleted: number; batchSize: number };
    do {
      result = (await withRetry(() =>
        client.mutation(api.quasar.deleteSessionTurns, {
          sessionId: mapped.session.sessionId,
          runId,
        }),
      )) as { deleted: number; batchSize: number };
    } while (result.deleted === result.batchSize);

    for (const rows of chunk(mapped.messages, INSERT_BATCH)) {
      await withRetry(() =>
        client.mutation(api.quasar.insertMessages, { messages: rows, runId }),
      );
    }
    for (const rows of chunk(mapped.toolCalls, INSERT_BATCH)) {
      await withRetry(() =>
        client.mutation(api.quasar.insertToolCalls, { toolCalls: rows, runId }),
      );
    }
    await withRetry(() =>
      client.mutation(api.quasar.commitSessionIngest, {
        sessionId: mapped.session.sessionId,
        runId,
      }),
    );
    // Only after a successful commit: the ledger entry must never claim an
    // ingest the server has not durably accepted.
    ledger.record(mapped.session.sessionId, sourceFingerprint);

    sessionsWritten += 1;
    messagesWritten += mapped.messages.length;
    toolCallsWritten += mapped.toolCalls.length;
    bytesWritten += mapped.bytesAdmitted;
  }

  // Project identity is derived state: a mapping change can re-key sessions
  // (e.g. path-keyed rows unifying onto a git-remote key), abandoning the old
  // project row. One canonical projectKey per project — drop empty ones.
  await withRetry(() => client.mutation(api.quasar.pruneEmptyProjects, {}));
  ledger.close();

  return {
    provider,
    sessionsWritten,
    sessionsSkipped,
    messages: messagesWritten,
    toolCalls: toolCallsWritten,
    diagnostics,
    durationMs: Date.now() - startedAt,
    approxMBWritten: Math.round((bytesWritten / 1_000_000) * 100) / 100,
  };
};

const runAllProvidersIngest = async (options: {
  readonly limit?: number;
  readonly force?: boolean;
  readonly reset?: boolean;
}): Promise<AllIngestReport> => {
  const reports: IngestReport[] = [];
  for (const provider of SUPPORTED_INGEST_PROVIDERS) {
    // One failing provider must never block the rest of the estate: record
    // the failure on its report and continue (hermes/grok run after codex).
    const startedAt = Date.now();
    try {
      reports.push(
        await runProviderIngest({
          provider,
          limit: options.limit,
          force: options.force,
          reset: options.reset,
        }),
      );
    } catch (error) {
      reports.push({
        provider,
        sessionsWritten: 0,
        sessionsSkipped: 0,
        messages: 0,
        toolCalls: 0,
        diagnostics: [],
        durationMs: Date.now() - startedAt,
        approxMBWritten: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    providers: reports,
    totalSessionsWritten: reports.reduce((sum, r) => sum + r.sessionsWritten, 0),
    totalSessionsSkipped: reports.reduce((sum, r) => sum + r.sessionsSkipped, 0),
    totalMessages: reports.reduce((sum, r) => sum + r.messages, 0),
    totalToolCalls: reports.reduce((sum, r) => sum + r.toolCalls, 0),
    totalDiagnostics: reports.reduce((sum, r) => sum + r.diagnostics.length, 0),
    totalDurationMs: reports.reduce((sum, r) => sum + r.durationMs, 0),
    totalApproxMBWritten: Math.round(reports.reduce((sum, r) => sum + r.approxMBWritten, 0) * 100) / 100,
  };
};

const providerOption = Options.text("provider").pipe(
  Options.withDescription(
    `Session provider to ingest (supported: ${SUPPORTED_INGEST_PROVIDERS.join(", ")}, all)`,
  ),
);
const rootOption = Options.text("root").pipe(
  Options.withDescription("Override the provider root directory (ignored when provider is 'all')"),
  Options.optional,
);
const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Ingest at most this many session files"),
  Options.optional,
);
const forceOption = Options.boolean("force").pipe(
  Options.withDescription(
    "Re-ingest sessions even when their source fingerprint is unchanged (use after a turn-mapping change)",
  ),
);
const resetLedgerOption = Options.boolean("reset-ledger").pipe(
  Options.withDescription(
    "Ignore and clear the local ingest fingerprint cache; re-consult the server for every session.",
  ),
);

export const ingestCommand = Command.make(
  "ingest",
  {
    provider: providerOption,
    root: rootOption,
    limit: limitOption,
    force: forceOption,
    resetLedger: resetLedgerOption,
  },
  ({ provider, root, limit, force, resetLedger }) =>
    executeJsonCommand(
      "ingest",
      Effect.gen(function* () {
        if (provider === "all") {
          return yield* Effect.tryPromise({
            try: () =>
              runAllProvidersIngest({
                limit: Option.getOrUndefined(limit),
                force,
                reset: resetLedger,
              }),
            catch: (error) => (error instanceof Error ? error : new Error(String(error))),
          });
        }
        if (!SUPPORTED_INGEST_PROVIDERS.includes(provider as Provider)) {
          return yield* Effect.fail(
            new CommandInputError({
              field: "provider",
              message: `Unsupported ingest provider: ${provider}. Supported: ${SUPPORTED_INGEST_PROVIDERS.join(", ")}, all.`,
            }),
          );
        }
        return yield* Effect.tryPromise({
          try: () =>
            runProviderIngest({
              provider,
              root: Option.getOrUndefined(root),
              limit: Option.getOrUndefined(limit),
              force,
              reset: resetLedger,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
      }),
    ),
);
