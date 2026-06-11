import { statSync } from "node:fs";

import { Command, Options } from "@effect/cli";
import { ConvexHttpClient } from "convex/browser";
import { Effect, Option } from "effect";

import { api } from "../../../../convex/_generated/api";

import {
  adaptersByProvider,
  loadMachineIdentity,
  redactSensitive,
  type ContentBlock,
  type NormalizedSession,
} from "@skastr0/quasar-core";

import { CommandInputError } from "../errors";
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

/** Bounded retry for transient platform errors (e.g. TooManyWrites — a documented
 * Convex property, expected never to fire at sequential pace). */
const RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 250;
const TRANSIENT_ERROR =
  /toomanywrites|too many writes|429|503|overloaded|rate.?limit|timed?.?out|fetch failed|econnrefused|econnreset|socket|network/i;

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
 * Maps a normalized Claude session to Quasar rows:
 * - user/assistant text turns → `messages` rows (seq = event sequence);
 * - plaintext thinking blocks → `role: "reasoning"` rows (the adapter emits
 *   them as assistant message blocks; promotion happens here);
 * - adapter ToolCall records → `toolCalls` rows with faithfully stringified
 *   input/output and seq taken from the originating tool_use event.
 * Every text passes through redactSensitive, then the boundary line.
 */
export const mapClaudeSession = (session: NormalizedSession): MappedSession => {
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

  const messages: MessageRow[] = [];
  for (const event of session.events) {
    if (event.role !== "user" && event.role !== "assistant") continue;
    if (INJECTED_EVENT_KINDS.has(event.kind)) continue;
    const reasoningParts: string[] = [];
    const textParts: string[] = [];
    if (event.contentBlocks.length === 0) {
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
    pushRow(event.role, textParts);
  }

  const seqByEventId = new Map(session.events.map((event) => [event.id, event.sequence]));
  const toolCalls: ToolCallRow[] = [];
  for (const toolCall of session.toolCalls) {
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const withRetry = async <T>(operation: () => Promise<T>): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= RETRY_ATTEMPTS || !TRANSIENT_ERROR.test(message)) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
};

const createConvexClient = (): ConvexHttpClient => {
  const url = process.env.CONVEX_SELF_HOSTED_URL ?? process.env.CONVEX_URL;
  if (url === undefined || url.length === 0) {
    throw new CommandInputError({
      field: "CONVEX_URL",
      message:
        "Convex backend URL not found: set CONVEX_SELF_HOSTED_URL or CONVEX_URL (bun auto-loads .env.local from the working directory).",
    });
  }
  // The quasar functions are public; no admin auth is needed for ingest.
  return new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true });
};

const runClaudeIngest = async (options: {
  readonly root?: string;
  readonly limit?: number;
  readonly force?: boolean;
}): Promise<IngestReport> => {
  const startedAt = Date.now();
  const client = createConvexClient();
  // One claim token per run: every turn mutation verifies it, so a concurrent
  // run that re-claims a session makes this run fail loudly instead of
  // interleaving duplicate rows.
  const runId = crypto.randomUUID();
  const stream = adaptersByProvider.get("claude")?.stream;
  if (stream === undefined) {
    throw new CommandInputError({
      field: "provider",
      message: "The claude adapter does not expose a session stream.",
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
    ...(options.root !== undefined ? { roots: { claude: options.root } } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  });

  for await (const item of items) {
    if (item.type !== "session") continue;
    const mapped = mapClaudeSession(item.session);
    diagnostics.push(...mapped.diagnostics);

    // The adapter never populates the stream fingerprint; stat the source file.
    const physicalPath = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
    const stat = statSync(physicalPath);
    const sourceFingerprint = JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs });

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
    const begin = await withRetry(() =>
      client.mutation(api.quasar.beginSessionIngest, {
        ...mapped.session,
        sourceFingerprint,
        runId,
        ...(options.force === true ? { force: true } : {}),
      }),
    );
    if (begin.skipped) {
      sessionsSkipped += 1;
      continue;
    }

    // Drain old turns before inserting; the mutation deletes one batch per call.
    let result: { deleted: number; batchSize: number };
    do {
      result = await withRetry(() =>
        client.mutation(api.quasar.deleteSessionTurns, {
          sessionId: mapped.session.sessionId,
          runId,
        }),
      );
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

    sessionsWritten += 1;
    messagesWritten += mapped.messages.length;
    toolCallsWritten += mapped.toolCalls.length;
    bytesWritten += mapped.bytesAdmitted;
  }

  return {
    provider: "claude",
    sessionsWritten,
    sessionsSkipped,
    messages: messagesWritten,
    toolCalls: toolCallsWritten,
    diagnostics,
    durationMs: Date.now() - startedAt,
    approxMBWritten: Math.round((bytesWritten / 1_000_000) * 100) / 100,
  };
};

const providerOption = Options.text("provider").pipe(
  Options.withDescription("Session provider to ingest (supported: claude)"),
);
const rootOption = Options.text("root").pipe(
  Options.withDescription("Override the provider root directory"),
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

export const ingestCommand = Command.make(
  "ingest",
  { provider: providerOption, root: rootOption, limit: limitOption, force: forceOption },
  ({ provider, root, limit, force }) =>
    executeJsonCommand(
      "ingest",
      Effect.gen(function* () {
        if (provider !== "claude") {
          return yield* Effect.fail(
            new CommandInputError({
              field: "provider",
              message: `Unsupported ingest provider: ${provider}. Supported: claude.`,
            }),
          );
        }
        return yield* Effect.tryPromise({
          try: () =>
            runClaudeIngest({
              root: Option.getOrUndefined(root),
              limit: Option.getOrUndefined(limit),
              force,
            }),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        });
      }),
    ),
);
