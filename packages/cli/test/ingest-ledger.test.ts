import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ingestLedgerExists, openIngestLedger } from "../src/ingest-ledger";

const LEDGER_FILE = "ingest-fingerprints.json";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "quasar-ledger-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const fp = (size: number, mtimeMs: number) => JSON.stringify({ size, mtimeMs });

describe("openIngestLedger", () => {
  test("has/record/clear round-trip persists across reopen", () => {
    const ledger = openIngestLedger(home);
    expect(ledger.has("s1", fp(10, 1))).toBe(false);
    ledger.record("s1", fp(10, 1));
    expect(ledger.has("s1", fp(10, 1))).toBe(true);
    ledger.close();

    // A fresh open reads the persisted file.
    const reopened = openIngestLedger(home);
    expect(reopened.has("s1", fp(10, 1))).toBe(true);
    reopened.clear();
    expect(reopened.has("s1", fp(10, 1))).toBe(false);
    reopened.close();

    // clear removed the backing file.
    expect(ingestLedgerExists(home)).toBe(false);
    expect(openIngestLedger(home).has("s1", fp(10, 1))).toBe(false);
  });

  test("has() matches only the exact recorded fingerprint", () => {
    const ledger = openIngestLedger(home);
    ledger.record("s1", fp(10, 1));
    // A stale (different) fingerprint for the same session is a miss.
    expect(ledger.has("s1", fp(20, 2))).toBe(false);
    // The exact pair still matches.
    expect(ledger.has("s1", fp(10, 1))).toBe(true);
    // A different session never matches.
    expect(ledger.has("s2", fp(10, 1))).toBe(false);
  });

  test("a fingerprint change invalidates the prior entry", () => {
    const ledger = openIngestLedger(home);
    ledger.record("s1", fp(10, 1));
    expect(ledger.has("s1", fp(10, 1))).toBe(true);
    // Re-record with a new fingerprint: the old one no longer matches.
    ledger.record("s1", fp(11, 5));
    expect(ledger.has("s1", fp(10, 1))).toBe(false);
    expect(ledger.has("s1", fp(11, 5))).toBe(true);
  });

  test("a missing file behaves as an empty ledger", () => {
    expect(ingestLedgerExists(home)).toBe(false);
    const ledger = openIngestLedger(home);
    expect(ledger.has("anything", fp(1, 1))).toBe(false);
  });

  test("a corrupt file behaves as an empty ledger and never throws", () => {
    writeFileSync(join(home, LEDGER_FILE), "{ not json", "utf8");
    const ledger = openIngestLedger(home);
    expect(ledger.has("s1", fp(10, 1))).toBe(false);
    // It recovers by writing a fresh, parseable file.
    ledger.record("s1", fp(10, 1));
    ledger.close();
    expect(openIngestLedger(home).has("s1", fp(10, 1))).toBe(true);
  });

  test("clear on a missing file does not throw", () => {
    const ledger = openIngestLedger(home);
    expect(() => ledger.clear()).not.toThrow();
    expect(existsSync(join(home, LEDGER_FILE))).toBe(false);
  });
});
