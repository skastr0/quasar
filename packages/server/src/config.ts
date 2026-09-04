import { Context, Effect, Layer } from "effect";

import { quasarLocalHome, sqlitePath } from "./paths";

export interface ServerConfig {
  readonly hostname: string;
  readonly port: number;
}

export interface LocalServerConfigService {
  readonly home: string;
  readonly sqlitePath: string;
  readonly server: ServerConfig;
}

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw.length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

/** SQLite busy handler window. Two connections exist against the same file
 * (the truth store and the durable queue), so a concurrent writer must wait
 * for the write lock instead of surfacing a raw SQLITE_BUSY to the caller. */
export const sqliteBusyTimeoutMs = (): number =>
  envInt("QUASAR_SQLITE_BUSY_TIMEOUT_MS", 5_000);

/** Backstop for one matrix scan. The p95 scan budget is 60ms; this is a
 * liveness deadline for a wedged or silently dead worker, not a latency
 * target — a scan that hits it fails typed rather than hanging forever. */
export const vectorScanDeadlineMs = (): number =>
  envInt("QUASAR_VECTOR_SCAN_DEADLINE_MS", 30_000);

/** Backstop for one scan worker's init handshake. A thread that dies during
 * init emits `close` and no `error`, and a wedged one emits neither, so the
 * spawn is only total if something bounds the wait. */
export const vectorWorkerInitTimeoutMs = (): number =>
  envInt("QUASAR_VECTOR_WORKER_INIT_TIMEOUT_MS", 30_000);

/** An ingest run writes its ledger row at start and again at its terminal
 * transition. A `running` row whose last write is older than this has no live
 * writer behind it (the whole five-provider estate ingests in minutes), so it
 * is an orphan of a killed process, not a slow run. */
export const ingestRunStaleAfterMs = (): number =>
  envInt("QUASAR_INGEST_RUN_STALE_MS", 6 * 60 * 60 * 1_000);

/** Retention window for terminal ingest-run ledger rows. */
export const ingestRunRetentionMs = (): number =>
  envInt("QUASAR_INGEST_RUN_RETENTION_DAYS", 30) * 24 * 60 * 60 * 1_000;

export class LocalServerConfig extends Context.Tag("@quasar/LocalServerConfig")<
  LocalServerConfig,
  LocalServerConfigService
>() {}

export const LocalServerConfigLive = Layer.effect(
  LocalServerConfig,
  Effect.sync(() =>
    LocalServerConfig.of({
      home: quasarLocalHome(),
      sqlitePath: sqlitePath(),
      server: {
        hostname: process.env.QUASAR_LOCAL_HOST?.trim() || "127.0.0.1",
        port: envInt("QUASAR_LOCAL_PORT", 6180),
      },
    }),
  ),
);
