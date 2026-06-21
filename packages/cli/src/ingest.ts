import { statSync } from "node:fs";

import { loadMachineIdentity } from "./core/machine";
import type { Provider } from "./core/schemas";

import { sourceFingerprintFor } from "./adapters/common";
import { adaptersByProvider, stableAdapters } from "./adapters/registry";
import type { SessionParseProbe } from "./adapters/types";
import { mapSession } from "./map";
import type { MappedSession, MessageRole } from "./model";

export interface IngestOptions {
  readonly provider: Provider | "all";
  readonly limit?: number;
  readonly force?: boolean;
  readonly ingestToken?: string;
}

export interface SearchDocumentPolicyStats {
  readonly total: number;
  readonly semanticEligible: number;
  readonly ignored: number;
}

const isSearchableRole = (role: MessageRole): role is "user" | "assistant" =>
  role === "user" || role === "assistant";

const summarizeSearchDocumentPolicy = (
  messages: readonly { readonly role: MessageRole }[],
): SearchDocumentPolicyStats => {
  let semanticEligible = 0;
  let ignored = 0;
  for (const message of messages) {
    if (isSearchableRole(message.role)) semanticEligible += 1;
    else ignored += 1;
  }
  return { total: messages.length, semanticEligible, ignored };
};

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
const remoteWriteAttempts = 3;
const remoteWriteRetryDelayMs = 250;

class RemoteIngestError extends Error {
  override readonly name = "RemoteIngestError";

  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const retryableRemoteWriteError = (error: unknown): boolean => {
  if (error instanceof RemoteIngestError) return error.retryable;
  return /socket|connection|closed|reset|timeout|timed out|econnreset|epipe|etimedout|fetch failed/i.test(errorMessage(error));
};

const postMappedSessionOnce = async (
  base: string,
  mapped: MappedSession,
  options: { readonly force?: boolean; readonly ingestToken?: string },
): Promise<SessionIngestOutcome> => {
  const url = new URL("/ingest/session", base.endsWith("/") ? base : `${base}/`);
  if (options.force === true) url.searchParams.set("force", "true");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
    headers["x-quasar-ingest-token"] = options.ingestToken;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ session: mapped }),
  });
  let body: { ok?: boolean; data?: { outcome?: SessionIngestOutcome }; error?: { message?: string } };
  try {
    body = await response.json() as { ok?: boolean; data?: { outcome?: SessionIngestOutcome }; error?: { message?: string } };
  } catch {
    throw new RemoteIngestError(`remote ingest returned invalid JSON with HTTP ${response.status}`, response.status >= 500);
  }
  if (!response.ok || body.ok === false || body.data?.outcome === undefined) {
    throw new RemoteIngestError(
      body.error?.message ?? body.data?.outcome?.detail ?? `remote ingest failed with HTTP ${response.status}`,
      response.status >= 500,
    );
  }
  return body.data.outcome;
};

export const postMappedSession = async (
  base: string,
  mapped: MappedSession,
  options: { readonly force?: boolean; readonly ingestToken?: string },
): Promise<SessionIngestOutcome> => {
  for (let attempt = 1; attempt <= remoteWriteAttempts; attempt += 1) {
    try {
      return await postMappedSessionOnce(base, mapped, options);
    } catch (error) {
      if (attempt === remoteWriteAttempts || !retryableRemoteWriteError(error)) throw error;
      await sleep(remoteWriteRetryDelayMs * attempt);
    }
  }
  throw new Error("remote ingest retry loop exited unexpectedly");
};

export const postFingerprintProbe = async (
  base: string,
  probe: SessionParseProbe,
  options: { readonly ingestToken?: string },
): Promise<boolean> => {
  const url = new URL("/ingest/fingerprint", base.endsWith("/") ? base : `${base}/`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
    headers["x-quasar-ingest-token"] = options.ingestToken;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ probe }),
  });
  const body = await response.json() as { ok?: boolean; data?: { unchanged?: boolean }; error?: { message?: string } };
  if (!response.ok || body.ok === false || typeof body.data?.unchanged !== "boolean") {
    throw new RemoteIngestError(body.error?.message ?? `remote fingerprint probe failed with HTTP ${response.status}`, response.status >= 500);
  }
  return body.data.unchanged;
};

const ingestProviderRemote = async (
  provider: Provider,
  options: IngestOptions,
  serverUrl: string,
): Promise<IngestReport> => {
  const startedAt = Date.now();
  const adapter = adaptersByProvider.get(provider);
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
      outcomes: [],
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

  const shouldParseSession = options.force === true
    ? undefined
    : async (probe: SessionParseProbe) => {
        try {
          const unchanged = await postFingerprintProbe(serverUrl, probe, options);
          if (!unchanged) return true;
          sessionsSeen += 1;
          sessionsSkipped += 1;
          outcomes.push({
            sessionId: probe.sessionId,
            status: "skipped",
            diagnostic: "unchanged_source_fingerprint",
            messagesWritten: 0,
            toolCallsWritten: 0,
            jobsEnqueued: 0,
          });
          return false;
        } catch {
          return true;
        }
      };

  const stream = adapter.stream({
    machine: loadMachineIdentity(),
    now: new Date().toISOString(),
    roots: configuredRoots(),
    limit: options.limit,
    shouldParseSession,
  });

  for await (const item of stream) {
    if (item.type !== "session") continue;
    sessionsSeen += 1;
    let sourceFingerprint: string;
    try {
      sourceFingerprint = fingerprintForItem(item);
    } catch (error) {
      const detail = errorMessage(error);
      sessionsFailed += 1;
      failures.push({ sessionId: item.session.id, diagnostic: "source_fingerprint_failed", error: detail });
      outcomes.push({ sessionId: item.session.id, status: "failed", diagnostic: "source_fingerprint_failed", detail, messagesWritten: 0, toolCallsWritten: 0, jobsEnqueued: 0 });
      continue;
    }
    let mapped: MappedSession;
    try {
      mapped = mapSession(item.session, sourceFingerprint);
    } catch (error) {
      const detail = errorMessage(error);
      sessionsFailed += 1;
      failures.push({ sessionId: item.session.id, diagnostic: "map_session_failed", error: detail });
      outcomes.push({ sessionId: item.session.id, status: "failed", diagnostic: "map_session_failed", detail, messagesWritten: 0, toolCallsWritten: 0, jobsEnqueued: 0 });
      continue;
    }
    try {
      const outcome = await postMappedSession(serverUrl, mapped, options);
      outcomes.push(outcome);
      if (outcome.status === "ok") {
        sessionsWritten += 1;
        messagesWritten += outcome.messagesWritten;
        toolCallsWritten += outcome.toolCallsWritten;
        jobsEnqueued += outcome.jobsEnqueued;
        const searchDocuments = outcome.searchDocuments ?? summarizeSearchDocumentPolicy(mapped.messages);
        semanticEligible += searchDocuments.semanticEligible;
        ignored += searchDocuments.ignored;
      } else if (outcome.status === "skipped") {
        sessionsSkipped += 1;
      } else {
        sessionsFailed += 1;
      }
    } catch (error) {
      const detail = errorMessage(error);
      sessionsFailed += 1;
      failures.push({ sessionId: mapped.session.sessionId, diagnostic: "remote_write_failed", error: detail });
      outcomes.push({ sessionId: mapped.session.sessionId, status: "failed", diagnostic: "remote_write_failed", detail, messagesWritten: 0, toolCallsWritten: 0, jobsEnqueued: 0 });
    }
  }

  return {
    provider,
    sessionsSeen,
    sessionsWritten,
    sessionsSkipped,
    sessionsFailed,
    messagesWritten,
    toolCallsWritten,
    jobsEnqueued,
    searchDocuments: { total: messagesWritten, semanticEligible, ignored },
    outcomes,
    failures,
    durationMs: Date.now() - startedAt,
  };
};

export const ingestRemote = async (
  options: IngestOptions,
  serverUrl: string,
): Promise<readonly IngestReport[]> => {
  const providers =
    options.provider === "all"
      ? stableAdapters.map((adapter) => adapter.provider)
      : [options.provider];
  const reports: IngestReport[] = [];
  for (const provider of providers) {
    reports.push(await ingestProviderRemote(provider, options, serverUrl));
  }
  return reports;
};
