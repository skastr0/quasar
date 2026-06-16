import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { quasarHome } from "@skastr0/quasar-core";

/**
 * Per-machine, local fingerprint cache consulted before a session is parsed.
 *
 * The ledger maps each session id to the source fingerprint of the last
 * successful ingest. Before parsing a session an adapter computes the cheap
 * probe (source path + statSync size/mtime) and asks whether that exact
 * (sessionId -> sourceFingerprint) pair is already recorded; on a hit the
 * expensive build/yield is skipped entirely.
 *
 * This is a REDUNDANT optimization, never a correctness gate: the server
 * remains the single authoritative idempotency check. A wrong "ingest" only
 * costs a cheap begin mutation the server then skips; a missing or unreadable
 * ledger behaves as empty (fail-soft) so a corrupt cache can never wrongly
 * suppress a re-ingest.
 */
export interface IngestLedger {
  /** True only on an exact (sessionId -> sourceFingerprint) match. */
  has(sessionId: string, sourceFingerprint: string): boolean;
  /** Record the fingerprint of a session's last successful ingest. */
  record(sessionId: string, sourceFingerprint: string): void;
  /** Forget every recorded fingerprint and remove the backing file. */
  clear(): void;
  /** Flush pending records to disk. */
  close(): void;
}

const ledgerPath = (homeDir?: string) =>
  join(homeDir ?? quasarHome(), "ingest-fingerprints.json");

/** True iff the backing file exists; daemon eligibility consults this. */
export const ingestLedgerExists = (homeDir?: string): boolean =>
  existsSync(ledgerPath(homeDir));

const readEntries = (path: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const entries: Record<string, string> = {};
    for (const [sessionId, fingerprint] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof fingerprint === "string") entries[sessionId] = fingerprint;
    }
    return entries;
  } catch {
    // Missing or unparseable file behaves as an empty ledger (fail-soft).
    return {};
  }
};

/**
 * Open the local ingest fingerprint ledger. Reads are served from memory;
 * `record` writes through to the backing JSON file so a crash mid-run keeps
 * the entries committed before it.
 */
export const openIngestLedger = (homeDir?: string): IngestLedger => {
  const path = ledgerPath(homeDir);
  const entries = readEntries(path);
  let dirty = false;

  const flush = () => {
    if (!dirty) return;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(entries), { encoding: "utf8", mode: 0o600 });
    dirty = false;
  };

  return {
    has: (sessionId, sourceFingerprint) => entries[sessionId] === sourceFingerprint,
    record: (sessionId, sourceFingerprint) => {
      if (entries[sessionId] === sourceFingerprint) return;
      entries[sessionId] = sourceFingerprint;
      dirty = true;
      flush();
    },
    clear: () => {
      for (const key of Object.keys(entries)) delete entries[key];
      dirty = false;
      try {
        rmSync(path, { force: true });
      } catch {
        // A missing file is already the cleared state (fail-soft).
      }
    },
    close: flush,
  };
};
