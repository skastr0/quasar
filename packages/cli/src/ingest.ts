import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadMachineIdentity } from "./core/machine";
import type { AdapterDiagnostic, DiagnosticSeverity, Provider } from "./core/schemas";
import { diagnosticSeverity, truncateDiagnosticMessage } from "./core/schemas";

import type { AmpPollState, AmpStreamOptions } from "./adapters/amp";
import { sourceFingerprintFor } from "./adapters/common";
import { adaptersByProvider, defaultIngestProviders } from "./adapters/registry";
import type { SessionParseProbe } from "./adapters/types";
import type { SessionId } from "./core/identity";
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

const daemonHomePath = (): string =>
  resolve(process.env.QUASAR_DAEMON_HOME ?? join(homedir(), ".config", "quasar"));

const manifestPath = (override?: string): string =>
  override ?? resolve(daemonHomePath(), "ingest-manifest.json");

// ---------------------------------------------------------------------------
// Amp poll state — two timestamps beside the manifest. Not thread data: losing
// it costs one extra list call, nothing else.
// ---------------------------------------------------------------------------

export const ampPollStatePath = (manifestOverride?: string): string =>
  join(dirname(manifestPath(manifestOverride)), "amp-poll-state.json");

export const loadAmpPollState = (path: string): AmpPollState => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const iso = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined);
    const lastFullListAt = iso(parsed.lastFullListAt);
    const lastHeadListAt = iso(parsed.lastHeadListAt);
    return {
      ...(lastFullListAt !== undefined ? { lastFullListAt } : {}),
      ...(lastHeadListAt !== undefined ? { lastHeadListAt } : {}),
    };
  } catch {
    return {};
  }
};

export const saveAmpPollState = (state: AmpPollState, path: string): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
};

/**
 * Stored `updated` per recent Amp session, from one server list call. Read
 * lazily: the daemon only needs it when a changed thread is still hot.
 */
const recentAmpSessionUpdatedAt = (
  serverUrl: string,
  options: { readonly timeoutMs?: number },
): ((sessionId: SessionId) => Promise<string | undefined>) => {
  let loaded: Promise<Map<string, string>> | undefined;
  const load = async (): Promise<Map<string, string>> => {
    const url = new URL("/sessions", serverUrl.endsWith("/") ? serverUrl : `${serverUrl}/`);
    url.searchParams.set("provider", "amp");
    url.searchParams.set("limit", "200");
    const byId = new Map<string, string>();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? defaultHttpTimeoutMs) });
      const body = await response.json() as { data?: { rows?: readonly { sessionId?: unknown; endedAt?: unknown }[] } };
      for (const row of body.data?.rows ?? []) {
        if (typeof row.sessionId === "string" && typeof row.endedAt === "string") byId.set(row.sessionId, row.endedAt);
      }
    } catch {
      // Unreachable server: treat every thread as never ingested, which means
      // export — the write will fail on its own and be retried next tick.
    }
    return byId;
  };
  return async (sessionId) => {
    loaded ??= load();
    return (await loaded).get(sessionId);
  };
};

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
  prime: "QUASAR_PRIME_ROOT",
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

/**
 * One named adapter diagnostic, aggregated over the walk.
 *
 * Aggregated rather than listed per occurrence on purpose: a single claude walk
 * drops thousands of unmodeled attachment records, and one report row each would
 * rebuild the log bomb by count instead of by size. One row per
 * (name, severity) with a count and a single capped sample keeps the report
 * bounded by the number of DISTINCT diagnostics, which is a handful.
 */
export interface IngestDiagnosticSummary {
  readonly name: string;
  readonly severity: DiagnosticSeverity;
  readonly count: number;
  /** First occurrence's message, capped at DIAGNOSTIC_MESSAGE_MAX_BYTES. */
  readonly sample: string;
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
  /** Every diagnostic the walk produced, at EVERY severity. Silence is a bug. */
  readonly diagnostics: readonly IngestDiagnosticSummary[];
  readonly diagnosticCounts: Readonly<Record<DiagnosticSeverity, number>>;
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
/**
 * The PHYSICAL file a diagnostic is about, when the adapter said so. This is the
 * manifest's key, so it is what decides whether a failure may block one file's
 * manifest entry or must block the whole provider walk. `undefined` means the
 * adapter did not attribute the diagnostic to a file and nothing may be
 * persisted on its behalf.
 */
const diagnosticPhysicalPath = (diagnostic: AdapterDiagnostic): string | undefined => {
  const details = diagnostic.details;
  if (details !== null && typeof details === "object") {
    const physicalPath = (details as { readonly physicalPath?: unknown }).physicalPath;
    if (typeof physicalPath === "string" && physicalPath.length > 0) return physicalPath;
    const sourcePath = (details as { readonly sourcePath?: unknown }).sourcePath;
    if (typeof sourcePath === "string" && sourcePath.length > 0) return sourcePath;
  }
  return undefined;
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
        diagnostics: [{
          name: "provider_stream_unavailable",
          severity: "error",
          count: 1,
          sample: `Provider ${provider} does not expose a stream`,
        }],
        diagnosticCounts: { info: 0, warning: 0, error: 1 },
        durationMs: Date.now() - startedAt,
      },
      manifestUpdates: {},
    };
  }

  let sessionsSeen = 0;
  let sessionsWritten = 0;
  let sessionsSkipped = 0;
  const failedSessionTargets = new Set<string>();
  /**
   * Physical files whose manifest entry must NOT persist because a session
   * sourced from them failed. Per-file rather than per-session because the
   * manifest's stat gate is per-file: a shared-DB adapter yields many sessions
   * from one file, and persisting that file's stat while one of its sessions
   * failed would suppress the re-read that session needs.
   */
  const poisonedPaths = new Set<string>();
  /**
   * An error diagnostic the adapter did not attribute to a physical file (a
   * whole-root failure, say). Nothing about the walk can be trusted as complete,
   * so no manifest entry persists — the pre-severity behaviour, now reached only
   * by genuinely unattributable failures.
   */
  let unattributableFailure = false;
  const diagnosticTally = new Map<string, IngestDiagnosticSummary>();
  const diagnosticCounts: Record<DiagnosticSeverity, number> = { info: 0, warning: 0, error: 0 };
  const tallyDiagnostic = (name: string, severity: DiagnosticSeverity, sample: string): void => {
    diagnosticCounts[severity] += 1;
    const key = `${severity}\x00${name}`;
    const existing = diagnosticTally.get(key);
    diagnosticTally.set(
      key,
      existing === undefined
        ? { name, severity, count: 1, sample }
        : { ...existing, count: existing.count + 1 },
    );
  };
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
  /**
   * Staged path -> the physical file whose sessions it belongs to. A SQLite
   * adapter stats a group (`db`, `db-wal`, `db-shm`, sidecars) but attributes
   * every session to the `db` alone, so poisoning by exact path would leave the
   * companions persisted at their new stat and the whole group would look
   * unchanged on the next tick — the failed session would never be retried.
   * Defaults to the path itself for one-file-per-session adapters.
   */
  const candidateOwners = new Map<string, string>();

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
    : (path: string, stat: import("node:fs").Stats, owner?: string): boolean => {
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
          candidateOwners.set(path, owner ?? path);
        }
        return shouldRead;
      };

  /**
   * The stat the INGESTED CONTENT belongs to, for a path `shouldReadFile` did
   * not already stage one for (`--force` skips that gate entirely). Taken
   * BEFORE the server round-trip and memoized per file: statting after the
   * write would record bytes a live agent appended during the round-trip as
   * already ingested, and those turns would never be read again.
   */
  const contentStats = new Map<string, ManifestEntry | undefined>();
  const contentStatFor = (path: string): ManifestEntry | undefined => {
    if (manifestCandidates.has(path)) return undefined;
    const memoized = contentStats.get(path);
    if (memoized !== undefined || contentStats.has(path)) return memoized;
    let entry: ManifestEntry | undefined;
    try {
      const stat = statSync(path);
      entry = { mtimeMs: stat.mtimeMs, size: stat.size, normalizationVersion: NORMALIZATION_VERSION };
    } catch {
      // non-fatal: a remote source (an exported thread URL) has no local stat.
      entry = undefined;
    }
    contentStats.set(path, entry);
    return entry;
  };

  // Amp is remote-only: under the daemon's `--provider all` it polls on the
  // adapter's throttle and holds hot threads; an explicit `--provider amp`
  // lists in full right now.
  const ampOptions: Partial<AmpStreamOptions> = provider === "amp" && options.provider === "all"
    ? {
        ampPoll: {
          state: loadAmpPollState(ampPollStatePath(options.manifestPath)),
          onState: (state) => saveAmpPollState(state, ampPollStatePath(options.manifestPath)),
        },
        lastIngestedAt: recentAmpSessionUpdatedAt(serverUrl, options),
      }
    : {};

  const stream = adapter.stream({
    machine: loadMachineIdentity(),
    now: new Date().toISOString(),
    roots: configuredRoots(),
    limit: options.limit,
    shouldParseSession,
    shouldReadFile,
    ...ampOptions,
  });

  for await (const item of stream) {
    if (item.type === "diagnostic") {
      // Severity, not status, decides what a diagnostic costs. A record-level
      // drop is named, counted, and surfaced — and its session still succeeds.
      const severity = diagnosticSeverity(item.diagnostic);
      const code = diagnosticCode(item.diagnostic);
      const message = truncateDiagnosticMessage(item.diagnostic.message);
      tallyDiagnostic(code, severity, message);
      if (severity === "error") {
        const target = diagnosticTarget(item.diagnostic, provider);
        failedSessionTargets.add(target);
        failures.push({ sessionId: target, diagnostic: code, error: message });
        const physicalPath = diagnosticPhysicalPath(item.diagnostic);
        if (physicalPath === undefined) unattributableFailure = true;
        else poisonedPaths.add(physicalPath);
      }
      continue;
    }
    if (item.type !== "session") continue;
    sessionsSeen += 1;
    const itemPhysicalPath = item.sourceUnit?.physicalPath ?? item.session.sourcePath;
    const failSession = (sessionId: string, diagnostic: string, detail: string): void => {
      const capped = truncateDiagnosticMessage(detail);
      failedSessionTargets.add(sessionId);
      poisonedPaths.add(itemPhysicalPath);
      failures.push({ sessionId, diagnostic, error: capped });
      tallyDiagnostic(diagnostic, "error", capped);
      outcomes.push({ sessionId, status: "failed", diagnostic, detail: capped, messagesWritten: 0, toolCallsWritten: 0, jobsEnqueued: 0 });
    };
    const contentStat = options.limit === undefined ? contentStatFor(itemPhysicalPath) : undefined;
    let sourceFingerprint: string;
    try {
      sourceFingerprint = fingerprintForItem(item);
    } catch (error) {
      failSession(item.session.id, "source_fingerprint_failed", errorMessage(error));
      continue;
    }
    let mapped: MappedSession;
    try {
      mapped = mapSession(item.session, sourceFingerprint);
    } catch (error) {
      failSession(item.session.id, "map_session_failed", errorMessage(error));
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
        // Stage the physical source stat. Another session sharing this file may
        // still fail, which poisons the path, so nothing is persisted yet.
        if (options.limit === undefined && contentStat !== undefined) {
          manifestCandidates.set(itemPhysicalPath, contentStat);
          candidateOwners.set(itemPhysicalPath, itemPhysicalPath);
        }
      } else if (outcome.status === "skipped") {
        sessionsSkipped += 1;
      } else {
        failedSessionTargets.add(outcome.sessionId);
        poisonedPaths.add(itemPhysicalPath);
        tallyDiagnostic(outcome.diagnostic ?? "session_write_rejected", "error", truncateDiagnosticMessage(outcome.detail ?? ""));
      }
    } catch (error) {
      failSession(mapped.session.sessionId, "remote_write_failed", errorMessage(error));
    }
  }

  // PER-SESSION manifest persistence. A staged source persists unless a session
  // sourced from that same physical file failed: one bad session no longer
  // forces its ~1250 healthy siblings to be re-parsed every tick.
  //
  // Crash convergence is preserved, and is strictly stronger than the old
  // all-or-nothing gate:
  //   - A path is STAGED at stat time (`shouldReadFile`), before any read, but
  //     it only PERSISTS if no session owning it failed. The server returning
  //     `ok` means it already left its two-phase apply — the `applying:`
  //     sentinel fingerprint has been replaced by the real one. A crash during
  //     apply leaves the sentinel in place, `postMappedSession` never returns
  //     `ok`, the owning path is poisoned, and the next tick re-parses it.
  //   - Poisoning is by OWNER, not by exact path, because a SQLite adapter
  //     stats a companion group (`db`, `db-wal`, `db-shm`, sidecars) while
  //     attributing every session to the `db`. Persisting a companion whose
  //     owner failed would make the whole group look unchanged next tick.
  //   - The manifest itself is written once, atomically (tmp + rename), after
  //     the whole run. A crash before that loses staged entries, which only
  //     costs a re-parse the server's fingerprint probe then skips.
  //   - A failure the adapter could not attribute to a file poisons everything,
  //     because an unattributable failure cannot prove any file complete.
  // Limited walks still persist nothing: they cannot prove that unseen sessions
  // inside a shared source are current.
  if (options.limit === undefined && !unattributableFailure) {
    for (const [path, entry] of manifestCandidates) {
      if (poisonedPaths.has(path)) continue;
      if (poisonedPaths.has(candidateOwners.get(path) ?? path)) continue;
      manifestUpdates[path] = entry;
    }
  }

  return {
    report: {
      provider,
      sessionsSeen,
      sessionsWritten,
      sessionsSkipped,
      sessionsFailed: failedSessionTargets.size,
      messagesWritten,
      toolCallsWritten,
      jobsEnqueued,
      searchDocuments: { total: searchDocumentsTotal, semanticEligible, ignored },
      outcomes,
      failures,
      diagnostics: [...diagnosticTally.values()],
      diagnosticCounts: { ...diagnosticCounts },
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
      ? defaultIngestProviders()
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
