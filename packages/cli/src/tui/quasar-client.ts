/**
 * In-process Quasar client for the TUI.
 *
 * The TUI sits on top of the CLI: it reuses the CLI's server-URL resolution
 * (`configuredServerUrl`) and the same HTTP contract the CLI commands drive.
 *
 * I/O works AROUND an opentui constraint: the render loop runs continuously and
 * starves libuv's poll phase, so in-process async `fetch` RESPONSE-BODY reads
 * hang under an active renderer (proven: headers return in ~30ms, bodies never
 * resolve; pause() does not help). But `setTimeout` and synchronous `fs` calls
 * keep working. So: spawn `curl` writing the body to a temp file (no streaming
 * read, no awaiting the also-starved process-exit), and POLL that file with
 * setTimeout + sync readFileSync until it parses as complete JSON. The result is
 * genuinely asynchronous — the UI stays responsive (animated "searching…",
 * cancellable) instead of freezing — without ever touching a starved code path.
 *
 * Parsing is split into pure functions (unit-tested against real response
 * fixtures) and the poll-based IO layer.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { configuredServerUrl } from "../client-config";

let ioCounter = 0;

export type SearchMode = "lexical" | "semantic" | "fusion";

export const SEARCH_MODES: readonly SearchMode[] = ["lexical", "semantic", "fusion"];

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
  readonly provider: string;
  readonly projectKey: string;
}

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
  readonly rawPath: string;
}

/** A typed outcome: data on success, a structured failure otherwise. */
export type Outcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The slice of the client the TUI depends on — injectable so tests use a fake. */
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
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const numOr = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

const failure = (envelope: unknown, fallbackMessage: string): { ok: false; code: string; message: string } => {
  if (isRecord(envelope) && isRecord(envelope.error)) {
    const e = envelope.error;
    return {
      ok: false,
      code: str(e.code) || str(e.type) || "Error",
      message: str(e.message) || fallbackMessage,
    };
  }
  return { ok: false, code: "Error", message: fallbackMessage };
};

const envelopeOk = (envelope: unknown): envelope is { data: unknown } =>
  isRecord(envelope) && envelope.ok === true;

// ----------------------------------------------------------------- pure parsers

export const parseSearch = (envelope: unknown): Outcome<readonly SearchMatch[]> => {
  if (!envelopeOk(envelope)) return failure(envelope, "search failed");
  const data = (envelope as { data: unknown }).data;
  const rawMatches = isRecord(data) && Array.isArray(data.matches) ? data.matches : [];
  const matches = rawMatches.flatMap((m): SearchMatch[] => {
    if (!isRecord(m)) return [];
    const row = isRecord(m.row) ? m.row : {};
    return [
      {
        key: str(m.key) || str(row.key),
        score: numOr(m.score, 0),
        sessionId: str(row.sessionId),
        seq: numOr(row.seq, 0),
        role: str(row.role),
        projectKey: str(row.projectKey),
        provider: str(row.provider),
        text: str(row.text),
      },
    ];
  });
  return { ok: true, value: matches };
};

export const parseSessions = (envelope: unknown): Outcome<readonly SessionRow[]> => {
  if (!envelopeOk(envelope)) return failure(envelope, "sessions failed");
  const data = (envelope as { data: unknown }).data;
  const rows = isRecord(data) && Array.isArray(data.rows) ? data.rows : [];
  return {
    ok: true,
    value: rows.flatMap((r): SessionRow[] =>
      !isRecord(r)
        ? []
        : [
            {
              sessionId: str(r.sessionId),
              projectKey: str(r.projectKey),
              provider: str(r.provider),
              agentName: strOrNull(r.agentName),
              title: strOrNull(r.title),
              startedAt: strOrNull(r.startedAt),
              updatedAt: strOrNull(r.updatedAt),
              messageCount: numOr(r.messageCount, 0),
              toolCallCount: numOr(r.toolCallCount, 0),
            },
          ],
    ),
  };
};

export const parseMessages = (envelope: unknown): Outcome<readonly MessageRow[]> => {
  if (!envelopeOk(envelope)) return failure(envelope, "messages failed");
  const data = (envelope as { data: unknown }).data;
  const rows = isRecord(data) && Array.isArray(data.rows) ? data.rows : [];
  return {
    ok: true,
    value: rows.flatMap((r): MessageRow[] =>
      !isRecord(r)
        ? []
        : [{ seq: numOr(r.seq, 0), role: str(r.role), text: str(r.text), ts: strOrNull(r.ts) }],
    ),
  };
};

export const parseToolCalls = (envelope: unknown): Outcome<readonly ToolCallRow[]> => {
  if (!envelopeOk(envelope)) return failure(envelope, "tool-calls failed");
  const data = (envelope as { data: unknown }).data;
  const rows = isRecord(data) && Array.isArray(data.rows) ? data.rows : [];
  return {
    ok: true,
    value: rows.flatMap((r): ToolCallRow[] =>
      !isRecord(r)
        ? []
        : [
            {
              id: str(r.id),
              sessionId: str(r.sessionId),
              seq: numOr(r.seq, 0),
              toolName: str(r.toolName),
              status: str(r.status),
              inputText: str(r.inputText),
              outputText: str(r.outputText),
              provider: str(r.provider),
              projectKey: str(r.projectKey),
            },
          ],
    ),
  };
};

export const parseProjects = (envelope: unknown): Outcome<readonly ProjectRow[]> => {
  if (!envelopeOk(envelope)) return failure(envelope, "projects failed");
  const data = (envelope as { data: unknown }).data;
  const rows = isRecord(data) && Array.isArray(data.rows) ? data.rows : [];
  return {
    ok: true,
    value: rows.flatMap((r): ProjectRow[] =>
      !isRecord(r)
        ? []
        : [{ projectKey: str(r.projectKey), displayName: str(r.displayName), rawPath: str(r.rawPath) }],
    ),
  };
};

// ----------------------------------------------------------------- sync IO layer

const QueryParams = (params: Record<string, string | number | undefined>): string => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && String(v).trim() !== "") usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
};

export class QuasarClient implements QuasarClientLike {
  constructor(
    private readonly serverUrl: string,
    private readonly timeoutSec = 30,
  ) {}

  /** Resolve a client from the same config the CLI uses; null if unconfigured. */
  static fromConfig(timeoutSec = 30): QuasarClient | null {
    const url = configuredServerUrl();
    return url === undefined ? null : new QuasarClient(url, timeoutSec);
  }

  /**
   * Spawn `curl` writing the body to a temp file, then poll the file with
   * setTimeout until it parses as complete JSON. Avoids both starved paths
   * (body-stream read, process-exit await) while staying non-blocking.
   */
  private requestPolled(
    path: string,
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const base = this.serverUrl.endsWith("/") ? this.serverUrl.slice(0, -1) : this.serverUrl;
    const url = `${base}/${path}${QueryParams(params)}`;
    const tmp = join(tmpdir(), `quasar-tui-io-${process.pid}-${ioCounter++}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn("curl", ["-s", "--max-time", String(this.timeoutSec), "-o", tmp, url], {
        stdio: "ignore",
      });
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        try {
          unlinkSync(tmp);
        } catch {
          // best-effort
        }
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = () => {
        try {
          child.kill();
        } catch {
          // best-effort
        }
        settle(() => reject(new Error("aborted")));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort);

      const deadline = Date.now() + (this.timeoutSec + 5) * 1000;
      const poll = () => {
        if (settled) return;
        if (existsSync(tmp)) {
          try {
            const json = JSON.parse(readFileSync(tmp, "utf8")) as unknown;
            return settle(() => resolve(json));
          } catch {
            // partial write — keep polling
          }
        }
        if (Date.now() > deadline) {
          try {
            child.kill();
          } catch {
            // best-effort
          }
          return settle(() => reject(new Error("request timed out")));
        }
        setTimeout(poll, 40);
      };
      setTimeout(poll, 20);
    });
  }

  private async run<T>(
    parse: (e: unknown) => Outcome<T>,
    path: string,
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<Outcome<T>> {
    try {
      return parse(await this.requestPolled(path, params, signal));
    } catch (error) {
      return { ok: false, code: "Network", message: error instanceof Error ? error.message : String(error) };
    }
  }

  search(
    query: string,
    mode: SearchMode,
    opts: { limit?: number; projectKey?: string; provider?: string; role?: string; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly SearchMatch[]>> {
    return this.run(
      parseSearch,
      `search/${mode}`,
      { q: query, limit: opts.limit, projectKey: opts.projectKey, provider: opts.provider, role: opts.role },
      opts.signal,
    );
  }

  sessions(
    opts: { provider?: string; projectKey?: string; limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly SessionRow[]>> {
    return this.run(
      parseSessions,
      "sessions",
      { provider: opts.provider, projectKey: opts.projectKey, limit: opts.limit, offset: opts.offset },
      opts.signal,
    );
  }

  messages(sessionId: string, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<Outcome<readonly MessageRow[]>> {
    return this.run(parseMessages, "messages", { sessionId, limit: opts.limit }, opts.signal);
  }

  toolCalls(
    opts: { sessionId?: string; projectKey?: string; provider?: string; toolName?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly ToolCallRow[]>> {
    return this.run(
      parseToolCalls,
      "tool-calls",
      {
        sessionId: opts.sessionId,
        projectKey: opts.projectKey,
        provider: opts.provider,
        toolName: opts.toolName,
        limit: opts.limit,
      },
      opts.signal,
    );
  }

  projects(
    opts: { limit?: number; offset?: number; signal?: AbortSignal } = {},
  ): Promise<Outcome<readonly ProjectRow[]>> {
    return this.run(parseProjects, "projects", { limit: opts.limit, offset: opts.offset }, opts.signal);
  }
}
