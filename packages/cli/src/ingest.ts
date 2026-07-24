import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadMachineIdentity } from "./core/machine";
import type { AdapterDiagnostic, Provider } from "./core/schemas";

import { sourceFingerprintFor } from "./adapters/common";
import { adaptersByProvider, stableAdapters } from "./adapters/registry";
import type { SessionParseProbe } from "./adapters/types";
import { mapSession } from "./map";
import type { MappedSession, MessageRole } from "./model";
import { NORMALIZATION_VERSION } from "./normalization-version";

// ---------------------------------------------------------------------------
// Ingest manifest — persistent stat cache for incremental ingest
// ---------------------------------------------------------------------------

export interface ManifestEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly normalizationVersion: number;
}

/** path -> { mtimeMs, size } recorded after a successful postMappedSession */
export type IngestManifest = Record<string, ManifestEntry>;

const manifestPath = (override?: string): string =>
  override ?? resolve(process.env.QUASAR_DAEMON_HOME ?? join(homedir(), ".config", "quasar"), "ingest-manifest.json");

export const loadManifest = (path?: string): IngestManifest => {
  const file = manifestPath(path);
  try {
    const raw = readFileSync(file, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as IngestManifest;
    }
  } catch {
    // missing or corrupt → start fresh
  }
  return {};
};

export const saveManifest = (manifest: IngestManifest, path?: string): void => {
  const file = manifestPath(path);
  mkdirSync(dirname(file), { recursive: true });
  const pending = `${file}.${process.pid}.tmp`;
  writeFileSync(pending, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(pending, file);
};

export const clearManifest = (path?: string): void => {
  saveManifest({}, path);
};

// ---------------------------------------------------------------------------

export interface IngestOptions {
  readonly provider: Provider | "all";
  readonly limit?: number;
  readonly force?: boolean;
  readonly ingestToken?: string;
  /** Bound all remote lifecycle, fingerprint, and session writes. */
  readonly timeoutMs?: number;
  /** Override path for the ingest manifest (default: QUASAR_DAEMON_HOME/ingest-manifest.json). */
  readonly manifestPath?: string;
}

export interface SearchDocumentPolicyStats {
  readonly total: number;
  readonly semanticEligible: number;
  readonly ignored: number;
}

const isSearchableRole = (role: MessageRole): role is "user" | "assistant" | "reasoning" =>
  role === "user" || role === "assistant" || role === "reasoning";

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
  omp: "QUASAR_OMP_ROOT",
  pi: "QUASAR_PI_ROOT",
  cursor: "QUASAR_CURSOR_ROOT",
  devin: "QUASAR_DEVIN_ROOT",
  amp: "QUASAR_AMP_ROOT",
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
  /** Row-delta counts from the server's diff apply: inserted + updated rows
   * only; unchanged rows of a re-sent session are never written or counted. */
  readonly messagesWritten: number;
  readonly toolCallsWritten: number;
  readonly jobsEnqueued: number;
  /** Policy counts for the full mapped session, distinct from row-delta writes. */
  readonly searchDocuments?: SearchDocumentPolicyStats;
  readonly delta?: {
    readonly messagesDeleted: number;
    readonly messagesUnchanged: number;
    readonly toolCallsDeleted: number;
    readonly toolCallsUnchanged: number;
  };
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
const diagnosticTarget = (diagnostic: AdapterDiagnostic, fallback: string): string => {
  const details = diagnostic.details;
  if (details !== null && typeof details === "object") {
    const sourcePath = (details as { readonly sourcePath?: unknown }).sourcePath;
    if (typeof sourcePath === "string" && sourcePath.length > 0) return sourcePath;
  }
  return diagnostic.rootPath ?? fallback;
};
const diagnosticCode = (diagnostic: AdapterDiagnostic): string => {
  const details = diagnostic.details;
  if (details !== null && typeof details === "object") {
    const code = (details as { readonly diagnostic?: unknown }).diagnostic;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "adapter_diagnostic";
};
const remoteWriteAttempts = 3;
const remoteWriteRetryDelayMs = 250;
const defaultHttpTimeoutMs = 60_000;

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
  options: { readonly force?: boolean; readonly ingestToken?: string; readonly timeoutMs?: number },
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
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultHttpTimeoutMs),
  });
  let body: { ok?: boolean; data?: { outcome?: SessionIngestOutcome }; error?: { message?: string } } | null;
  try {
    body = await response.json() as { ok?: boolean; data?: { outcome?: SessionIngestOutcome }; error?: { message?: string } } | null;
  } catch {
    throw new RemoteIngestError(`remote ingest returned invalid JSON with HTTP ${response.status}`, response.ok || response.status >= 500);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RemoteIngestError(`remote ingest returned a non-object JSON body with HTTP ${response.status}`, response.ok || response.status >= 500);
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
  options: { readonly force?: boolean; readonly ingestToken?: string; readonly timeoutMs?: number },
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
  options: { readonly ingestToken?: string; readonly timeoutMs?: number },
): Promise<boolean> => {
  const url = new URL("/ingest/fingerprint", base.endsWith("/") ? base : `${base}/`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
    headers["x-quasar-ingest-token"] = options.ingestToken;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      probe: { ...probe, normalizationVersion: NORMALIZATION_VERSION },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultHttpTimeoutMs),
  });
  let body: { ok?: boolean; data?: { unchanged?: boolean }; error?: { message?: string } } | null;
  try {
    body = await response.json() as { ok?: boolean; data?: { unchanged?: boolean }; error?: { message?: string } } | null;
  } catch {
    throw new RemoteIngestError(`remote fingerprint probe returned invalid JSON with HTTP ${response.status}`, response.ok || response.status >= 500);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RemoteIngestError(`remote fingerprint probe returned a non-object JSON body with HTTP ${response.status}`, response.ok || response.status >= 500);
  }
  if (!response.ok || body.ok === false || typeof body.data?.unchanged !== "boolean") {
    throw new RemoteIngestError(body.error?.message ?? `remote fingerprint probe failed with HTTP ${response.status}`, response.status >= 500);
  }
  return body.data.unchanged;
};

/**
 * Best-effort high watermark for remote list pagination (Amp). Reads the most
 * recently updated session for a provider via GET /sessions?provider=&limit=1
 * and returns its `endedAt` (updated_at). Failures return undefined so ingest
 * falls back to a full list walk. Ingest must omit this under `--force` so
 * early-stop cannot hide older threads; threads never enumerated never reach
 * shouldParseSession.
 */
export const getProviderHighWatermark = async (
  base: string,
  provider: Provider,
  options: { readonly ingestToken?: string; readonly timeoutMs?: number } = {},
): Promise<string | undefined> => {
  try {
    const url = new URL("/sessions", base.endsWith("/") ? base : `${base}/`);
    url.searchParams.set("provider", provider);
    url.searchParams.set("limit", "1");
    const headers: Record<string, string> = {};
    if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
      headers["x-quasar-ingest-token"] = options.ingestToken;
    }
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? defaultHttpTimeoutMs),
    });
    if (!response.ok) return undefined;
    const body = await response.json() as {
      ok?: boolean;
      data?: { rows?: readonly { endedAt?: unknown }[] };
    } | null;
    if (body === null || typeof body !== "object" || body.ok === false) return undefined;
    const endedAt = body.data?.rows?.[0]?.endedAt;
    return typeof endedAt === "string" && endedAt.length > 0 ? endedAt : undefined;
  } catch {
    return undefined;
  }
};

interface IngestRunWrite {
  readonly runId: string;
  readonly provider: Provider | "all";
  readonly status: "running" | "completed" | "failed";
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly sessionsSeen: number;
  readonly sessionsWritten: number;
  readonly sessionsSkipped: number;
  readonly sessionsFailed: number;
}

const postIngestRunOnce = async (
  base: string,
  run: IngestRunWrite,
  options: { readonly ingestToken?: string; readonly timeoutMs?: number },
): Promise<void> => {
  const url = new URL("/ingest/run", base.endsWith("/") ? base : `${base}/`);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.ingestToken !== undefined && options.ingestToken.trim() !== "") {
    headers["x-quasar-ingest-token"] = options.ingestToken;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ run }),
    signal: AbortSignal.timeout(options.timeoutMs ?? defaultHttpTimeoutMs),
  });
  let body: { ok?: boolean; error?: { message?: string } } | null;
  try {
    body = await response.json() as { ok?: boolean; error?: { message?: string } } | null;
  } catch {
    throw new RemoteIngestError(`remote ingest run returned invalid JSON with HTTP ${response.status}`, response.ok || response.status >= 500);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RemoteIngestError(`remote ingest run returned a non-object JSON body with HTTP ${response.status}`, response.ok || response.status >= 500);
  }
  if (!response.ok || body.ok === false) {
    throw new RemoteIngestError(body.error?.message ?? `remote ingest run failed with HTTP ${response.status}`, response.status >= 500);
  }
};

export const postIngestRun = async (
  base: string,
  run: IngestRunWrite,
  options: { readonly ingestToken?: string; readonly timeoutMs?: number },
): Promise<void> => {
  for (let attempt = 1; attempt <= remoteWriteAttempts; attempt += 1) {
    try {
      await postIngestRunOnce(base, run, options);
      return;
    } catch (error) {
      if (attempt === remoteWriteAttempts || !retryableRemoteWriteError(error)) throw error;
      await sleep(remoteWriteRetryDelayMs * attempt);
    }
  }
  throw new Error("remote ingest run retry loop exited unexpectedly");
};

const ingestProviderRemote = async (
  provider: Provider,
  options: IngestOptions,
  serverUrl: string,
  manifest: IngestManifest,
): Promise<{ report: IngestReport; manifestUpdates: IngestManifest }> => {
  const startedAt = Date.now();
  const adapter = adaptersByProvider.get(provider);
  if (adapter?.stream === undefined) {
    return {
      report: {
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
      },
      manifestUpdates: {},
    };
  }

  let sessionsSeen = 0;
  let sessionsWritten = 0;
  let sessionsSkipped = 0;
  let sessionsFailed = 0;
  let messagesWritten = 0;
  let toolCallsWritten = 0;
  let jobsEnqueued = 0;
  let searchDocumentsTotal = 0;
  let semanticEligible = 0;
  let ignored = 0;
  const outcomes: SessionIngestOutcome[] = [];
  const failures: { sessionId: string; diagnostic: string; error: string }[] = [];
  const manifestUpdates: IngestManifest = {};
  const manifestCandidates = new Map<string, ManifestEntry>();

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

  /**
   * Stat-level gate: suppress content reads for files whose mtime+size match
   * the last successful ingest record. --force bypasses this entirely.
   */
  const shouldReadFile = options.force === true
    ? undefined
    : (path: string, stat: import("node:fs").Stats): boolean => {
        const entry = manifest[path];
        const shouldRead = entry === undefined
          || entry.normalizationVersion !== NORMALIZATION_VERSION
          || entry.mtimeMs !== stat.mtimeMs
          || entry.size !== stat.size;
        if (shouldRead) {
          manifestCandidates.set(path, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            normalizationVersion: NORMALIZATION_VERSION,
          });
        }
        return shouldRead;
      };

  // --force must walk the full remote list; watermark early-stop would hide
  // older threads that never reach shouldParseSession.
  const highWatermark = provider === "amp" && options.force !== true
    ? await getProviderHighWatermark(serverUrl, provider, options)
    : undefined;

  const stream = adapter.stream({
    machine: loadMachineIdentity(),
    now: new Date().toISOString(),
    roots: configuredRoots(),
    limit: options.limit,
    ...(highWatermark !== undefined ? { highWatermark } : {}),
    shouldParseSession,
    shouldReadFile,
  });

  for await (const item of stream) {
    if (item.type === "diagnostic") {
      if (item.diagnostic.status === "error") {
        sessionsFailed += 1;
        failures.push({
          sessionId: diagnosticTarget(item.diagnostic, provider),
          diagnostic: diagnosticCode(item.diagnostic),
          error: item.diagnostic.message,
        });
      }
      continue;
    }
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
        searchDocumentsTotal += searchDocuments.total;
        semanticEligible += searchDocuments.semanticEligible;
        ignored += searchDocuments.ignored;
        // Stage the physical source stat. The provider walk may still fail on
        // another session sharing this file, so nothing is persisted yet.
        if (options.limit === undefined) {
          const physicalPath = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
          try {
            const fileStat = statSync(physicalPath);
            manifestCandidates.set(physicalPath, {
              mtimeMs: fileStat.mtimeMs,
              size: fileStat.size,
              normalizationVersion: NORMALIZATION_VERSION,
            });
          } catch {
            // non-fatal: best-effort manifest update
          }
        }
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

  // A full successful provider walk proves every staged source either matched
  // the server's current normalization fingerprint or was posted successfully.
  // This also converges shared-DB adapters whose per-session probe fingerprints
  // intentionally differ from the DB file stat. Limited walks cannot prove that
  // unseen sessions are current, and failed walks must retry every sibling
  // session, so neither persists file-level manifest state.
  if (options.limit === undefined && sessionsFailed === 0) {
    for (const [path, entry] of manifestCandidates) {
      manifestUpdates[path] = entry;
    }
  }

  return {
    report: {
      provider,
      sessionsSeen,
      sessionsWritten,
      sessionsSkipped,
      sessionsFailed,
      messagesWritten,
      toolCallsWritten,
      jobsEnqueued,
      searchDocuments: { total: searchDocumentsTotal, semanticEligible, ignored },
      outcomes,
      failures,
      durationMs: Date.now() - startedAt,
    },
    manifestUpdates,
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

  // Load manifest once; --force skips the stat gate but still persists updates
  // so the manifest stays current for the next non-forced run.
  const manifest = loadManifest(options.manifestPath);
  const reports: IngestReport[] = [];
  let merged: IngestManifest = { ...manifest };

  for (const provider of providers) {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await postIngestRun(serverUrl, {
      runId, provider, status: "running", startedAt,
      sessionsSeen: 0, sessionsWritten: 0, sessionsSkipped: 0, sessionsFailed: 0,
    }, options);
    let result: { report: IngestReport; manifestUpdates: IngestManifest };
    try {
      result = await ingestProviderRemote(provider, options, serverUrl, manifest);
    } catch (error) {
      try {
        await postIngestRun(serverUrl, {
          runId, provider, status: "failed", startedAt, completedAt: new Date().toISOString(),
          sessionsSeen: 0, sessionsWritten: 0, sessionsSkipped: 0, sessionsFailed: 1,
        }, options);
      } catch {
        // The provider failure is the primary error. A best-effort terminal
        // ledger update must not replace it.
      }
      throw error;
    }
    const { report, manifestUpdates } = result;
    await postIngestRun(serverUrl, {
      runId, provider, status: report.sessionsFailed === 0 ? "completed" : "failed", startedAt,
      completedAt: new Date().toISOString(),
      sessionsSeen: report.sessionsSeen,
      sessionsWritten: report.sessionsWritten,
      sessionsSkipped: report.sessionsSkipped,
      sessionsFailed: report.sessionsFailed,
    }, options);
    reports.push(report);
    merged = { ...merged, ...manifestUpdates };
  }

  // Persist only when there are new entries to record.
  const hasUpdates = Object.keys(merged).length !== Object.keys(manifest).length
    || Object.entries(merged).some(([k, v]) =>
      manifest[k]?.mtimeMs !== v.mtimeMs
      || manifest[k]?.size !== v.size
      || manifest[k]?.normalizationVersion !== v.normalizationVersion);
  if (hasUpdates) {
    saveManifest(merged, options.manifestPath);
  }

  return reports;
};
