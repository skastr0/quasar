/**
 * Poll-based HTTP client for the OpenTUI render loop.
 *
 * OpenTUI starves fetch body reads while rendering. Curl writes each response to
 * a temporary file and a timer polls for complete JSON, keeping the UI live and
 * cancellable. Query collections use the same local typed projection adapter
 * as the CLI; curl only performs canonical GET resource reads.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { QueryResponse, QuerySpec } from "@skastr0/quasar-protocol";

import { configuredServerUrl } from "../client-config";
import {
  decodeQueryOutput,
  QueryInputError,
  QueryProtocolError,
  queryResourceRequest,
  queryResponseFromResource,
} from "../query-client";
import { messagesQuery, searchQuery, sessionsQuery, toolCallsQuery } from "../query-spec";

let ioCounter = 0;

export type SearchMode = "lexical" | "semantic" | "fusion";
export const SEARCH_MODES: readonly SearchMode[] = ["lexical", "semantic", "fusion"];
const TUI_SEARCH_FIELDS = [
  "messageId",
  "sessionId",
  "sequence",
  "projectKey",
  "provider",
  "role",
  "text",
  "score",
] as const;

export interface SearchMatch {
  readonly key: string;
  readonly score: number;
  readonly sessionId: string;
  readonly seq: number;
  readonly role: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly text: string;
}

export interface SessionRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: string;
  readonly agentName: string | null;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly messageCount: number;
  readonly toolCallCount: number;
}

export interface MessageRow {
  readonly seq: number;
  readonly role: string;
  readonly text: string;
  readonly ts: string | null;
}

export interface ToolCallRow {
  readonly id: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly toolName: string;
  readonly status: string;
  readonly inputText: string;
  readonly outputText: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly provider: string;
  readonly projectKey: string;
}

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
  readonly rawPath: string;
}

export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

export interface QuasarClientLike {
  search(
    query: string,
    mode: SearchMode,
    opts?: { limit?: number; projectKey?: string; provider?: string; role?: string; signal?: AbortSignal },
  ): Promise<Outcome<readonly SearchMatch[]>>;
  messages(sessionId: string, opts?: { limit?: number; signal?: AbortSignal }): Promise<Outcome<readonly MessageRow[]>>;
  toolCalls(opts?: {
    sessionId?: string;
    projectKey?: string;
    provider?: string;
    toolName?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<Outcome<readonly ToolCallRow[]>>;
  toolCall(id: string, opts?: { signal?: AbortSignal }): Promise<Outcome<ToolCallRow>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";
const str = (value: unknown): string => typeof value === "string" ? value : "";
const numOr = (value: unknown, fallback = 0): number => typeof value === "number" ? value : fallback;
const strOrNull = (value: unknown): string | null => typeof value === "string" ? value : null;

const failure = (envelope: unknown, fallbackMessage: string): { ok: false; code: string; message: string } => {
  if (isRecord(envelope) && isRecord(envelope.error)) {
    return {
      ok: false,
      code: str(envelope.error.code) || str(envelope.error.type) || "Error",
      message: str(envelope.error.message) || fallbackMessage,
    };
  }
  return { ok: false, code: "Error", message: fallbackMessage };
};

const payloadText = (value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
};

const queryItems = (input: unknown, spec: QuerySpec): QueryResponse =>
  decodeQueryOutput(input, spec);

export const parseSearch = (input: unknown, spec = searchQuery({ text: "fixture", mode: "lexical" })): Outcome<readonly SearchMatch[]> => {
  if (isRecord(input) && input.ok === false) return failure(input, "search failed");
  try {
    const response = queryItems(input, spec);
    if (response.kind !== "search") return { ok: false, code: "Protocol", message: "expected search response" };
    return {
      ok: true,
      value: response.items.map((item) => ({
        key: str(item.messageId) || `${str(item.sessionId)}:${numOr(item.sequence)}:${str(item.role)}`,
        score: numOr(item.score),
        sessionId: str(item.sessionId),
        seq: numOr(item.sequence),
        role: str(item.role),
        projectKey: str(item.projectKey),
        provider: str(item.provider),
        text: str(item.text),
      })),
    };
  } catch (error) {
    return { ok: false, code: "Protocol", message: error instanceof Error ? error.message : String(error) };
  }
};

export const parseSessions = (input: unknown, spec = sessionsQuery({ projection: { detail: "detail" } })): Outcome<readonly SessionRow[]> => {
  if (isRecord(input) && input.ok === false) return failure(input, "sessions failed");
  try {
    const response = queryItems(input, spec);
    if (response.kind !== "sessions") return { ok: false, code: "Protocol", message: "expected sessions response" };
    return {
      ok: true,
      value: response.items.map((item) => ({
        sessionId: str(item.sessionId),
        projectKey: str(item.projectKey),
        provider: str(item.provider),
        agentName: strOrNull(item.agentName),
        title: strOrNull(item.title),
        startedAt: strOrNull(item.startedAt),
        updatedAt: strOrNull(item.endedAt),
        messageCount: numOr(item.messageCount),
        toolCallCount: numOr(item.toolCallCount),
      })),
    };
  } catch (error) {
    return { ok: false, code: "Protocol", message: error instanceof Error ? error.message : String(error) };
  }
};

export const parseMessages = (input: unknown, spec: QuerySpec): Outcome<readonly MessageRow[]> => {
  if (isRecord(input) && input.ok === false) return failure(input, "messages failed");
  try {
    const response = queryItems(input, spec);
    if (response.kind !== "messages") return { ok: false, code: "Protocol", message: "expected messages response" };
    return {
      ok: true,
      value: response.items.map((item) => ({
        seq: numOr(item.sequence),
        role: str(item.role),
        text: str(item.text),
        ts: strOrNull(item.timestamp),
      })),
    };
  } catch (error) {
    return { ok: false, code: "Protocol", message: error instanceof Error ? error.message : String(error) };
  }
};

export const parseToolCalls = (input: unknown, spec: QuerySpec): Outcome<readonly ToolCallRow[]> => {
  if (isRecord(input) && input.ok === false) return failure(input, "tool-calls failed");
  try {
    const response = queryItems(input, spec);
    if (response.kind !== "toolCalls") return { ok: false, code: "Protocol", message: "expected toolCalls response" };
    return {
      ok: true,
      value: response.items.map((item) => ({
        id: str(item.toolCallId),
        sessionId: str(item.sessionId),
        seq: numOr(item.sequence),
        toolName: str(item.toolName),
        status: str(item.status),
        inputText: payloadText(item.input),
        outputText: payloadText(item.output),
        inputBytes: numOr(item.inputBytes),
        outputBytes: numOr(item.outputBytes),
        provider: str(item.provider),
        projectKey: str(item.projectKey),
      })),
    };
  } catch (error) {
    return { ok: false, code: "Protocol", message: error instanceof Error ? error.message : String(error) };
  }
};

export const parseProjects = (envelope: unknown): Outcome<readonly ProjectRow[]> => {
  if (!isRecord(envelope) || envelope.ok !== true || !isRecord(envelope.data)) {
    return failure(envelope, "projects failed");
  }
  const rows = Array.isArray(envelope.data.rows) ? envelope.data.rows : [];
  return {
    ok: true,
    value: rows.flatMap((row): ProjectRow[] => !isRecord(row) ? [] : [{
      projectKey: str(row.projectKey),
      displayName: str(row.displayName),
      rawPath: str(row.rawPath),
    }]),
  };
};

const queryParams = (params: Record<string, string | number | undefined>): string => {
  const values = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && String(value).trim() !== "") values.set(key, String(value));
  }
  const encoded = values.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

export class QuasarClient implements QuasarClientLike {
  constructor(private readonly serverUrl: string, private readonly timeoutSec = 30) {}

  static fromConfig(timeoutSec = 30): QuasarClient | null {
    const url = configuredServerUrl();
    return url === undefined ? null : new QuasarClient(url, timeoutSec);
  }

  private requestPolled(
    path: string,
    params: Readonly<Record<string, string | number | undefined>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const base = this.serverUrl.endsWith("/") ? this.serverUrl.slice(0, -1) : this.serverUrl;
    const url = `${base}/${path}${queryParams(params)}`;
    const tmp = join(tmpdir(), `quasar-tui-io-${process.pid}-${ioCounter++}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const requestArgs = ["-s", "--max-time", String(this.timeoutSec), "-o", tmp];
      requestArgs.push(url);
      const child = spawn("curl", requestArgs, { stdio: "ignore" });
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        try { unlinkSync(tmp); } catch { /* best effort */ }
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = () => {
        try { child.kill(); } catch { /* best effort */ }
        settle(() => reject(new Error("aborted")));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort);

      const deadline = Date.now() + (this.timeoutSec + 5) * 1_000;
      const poll = () => {
        if (settled) return;
        if (existsSync(tmp)) {
          try {
            const json = JSON.parse(readFileSync(tmp, "utf8")) as unknown;
            return settle(() => resolve(json));
          } catch { /* partial write */ }
        }
        if (Date.now() > deadline) {
          try { child.kill(); } catch { /* best effort */ }
          return settle(() => reject(new Error("request timed out")));
        }
        setTimeout(poll, 40);
      };
      setTimeout(poll, 20);
    });
  }

  private async requestQueryResource(spec: QuerySpec, signal?: AbortSignal): Promise<unknown> {
    const request = queryResourceRequest(spec);
    const input = await this.requestPolled(request.path, request.params, signal);
    return isRecord(input) && input.ok === false
      ? input
      : queryResponseFromResource(input, spec);
  }

  private queryFailure(error: unknown): { readonly ok: false; readonly code: string; readonly message: string } {
    return {
      ok: false,
      code: error instanceof QueryProtocolError
        ? "Protocol"
        : error instanceof QueryInputError
          ? "Input"
          : "Network",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private async runQuery<T>(
    spec: QuerySpec,
    parse: (input: unknown, expected: QuerySpec) => Outcome<T>,
    signal?: AbortSignal,
  ): Promise<Outcome<T>> {
    try {
      return parse(await this.requestQueryResource(spec, signal), spec);
    } catch (error) {
      return this.queryFailure(error);
    }
  }

  private async collectQuery<T>(
    requestedLimit: number,
    build: (page: { readonly limit: number; readonly cursor?: string }) => QuerySpec,
    parse: (input: unknown, expected: QuerySpec) => Outcome<readonly T[]>,
    signal?: AbortSignal,
  ): Promise<Outcome<readonly T[]>> {
    const target = Number.isInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 1;
    const pageLimit = Math.min(200, target);
    const items: T[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    while (items.length < target) {
      const spec = build({
        limit: pageLimit,
        ...(cursor === undefined ? {} : { cursor }),
      });
      let input: unknown;
      try {
        input = await this.requestQueryResource(spec, signal);
      } catch (error) {
        return this.queryFailure(error);
      }
      const result = parse(input, spec);
      if (!result.ok) return result;
      items.push(...result.value);

      let nextCursor: string | undefined;
      try {
        nextCursor = decodeQueryOutput(input, spec).page.nextCursor;
      } catch (error) {
        return { ok: false, code: "Protocol", message: error instanceof Error ? error.message : String(error) };
      }
      if (nextCursor === undefined || result.value.length === 0) break;
      if (seenCursors.has(nextCursor)) {
        return { ok: false, code: "Protocol", message: "query pagination repeated a cursor" };
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { ok: true, value: items.slice(0, target) };
  }

  search(query: string, mode: SearchMode, opts: {
    limit?: number; projectKey?: string; provider?: string; role?: string; signal?: AbortSignal;
  } = {}): Promise<Outcome<readonly SearchMatch[]>> {
    const spec = searchQuery({
      text: query,
      mode,
      filters: {
        projectKey: opts.projectKey,
        providers: opts.provider === undefined ? undefined : [opts.provider],
        role: opts.role,
      },
      projection: { detail: "detail", fields: TUI_SEARCH_FIELDS, limit: opts.limit },
    });
    return this.runQuery(spec, parseSearch, opts.signal);
  }

  sessions(opts: {
    provider?: string; projectKey?: string; limit?: number; signal?: AbortSignal;
  } = {}): Promise<Outcome<readonly SessionRow[]>> {
    return this.collectQuery(
      opts.limit ?? 100,
      (page) => sessionsQuery({
        filters: {
          projectKey: opts.projectKey,
          providers: opts.provider === undefined ? undefined : [opts.provider],
        },
        projection: { detail: "detail", ...page },
      }),
      parseSessions,
      opts.signal,
    );
  }

  messages(sessionId: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<Outcome<readonly MessageRow[]>> {
    return this.collectQuery(
      opts.limit ?? 100,
      (page) => messagesQuery({ sessionId, projection: page }),
      parseMessages,
      opts.signal,
    );
  }

  toolCalls(opts: {
    sessionId?: string; projectKey?: string; provider?: string; toolName?: string; limit?: number; signal?: AbortSignal;
  } = {}): Promise<Outcome<readonly ToolCallRow[]>> {
    return this.collectQuery(
      opts.limit ?? 100,
      (page) => toolCallsQuery({
        filters: {
          sessionId: opts.sessionId,
          projectKey: opts.projectKey,
          providers: opts.provider === undefined ? undefined : [opts.provider],
          toolName: opts.toolName,
        },
        projection: page,
      }),
      parseToolCalls,
      opts.signal,
    );
  }

  async toolCall(id: string, opts: { signal?: AbortSignal } = {}): Promise<Outcome<ToolCallRow>> {
    const spec = toolCallsQuery({
      filters: { toolCallId: id },
      projection: { detail: "detail", limit: 1 },
    });
    const result = await this.runQuery(spec, parseToolCalls, opts.signal);
    if (!result.ok) return result;
    const row = result.value[0];
    return row === undefined
      ? { ok: false, code: "NotFound", message: `tool call not found: ${id}` }
      : { ok: true, value: row };
  }

  async projects(opts: { limit?: number; offset?: number; signal?: AbortSignal } = {}): Promise<Outcome<readonly ProjectRow[]>> {
    try {
      return parseProjects(await this.requestPolled("projects", { limit: opts.limit, offset: opts.offset }, opts.signal));
    } catch (error) {
      return { ok: false, code: "Network", message: error instanceof Error ? error.message : String(error) };
    }
  }
}
