import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { IngestLedger, type SourceFileUnit, type UnitFingerprint } from "../src/ledger";

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);

let tempDir: string | undefined;
let ledger: IngestLedger | undefined;

const unit: SourceFileUnit = {
  provider: "codex",
  adapterId: "codex-jsonl",
  sourcePath: "/fixtures/codex/session-a.jsonl",
};

const fingerprintA: UnitFingerprint = { size: 100, mtimeMs: 1_000 };
const fingerprintB: UnitFingerprint = { size: 120, mtimeMs: 2_000 };

const openLedger = async () => {
  tempDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "quasar-ledger-"));
  ledger = await run(
    IngestLedger.open({
      path: join(tempDir, "ledger.sqlite"),
      machineId: "machine:test",
    }),
  );
  return ledger;
};

describe("ingest ledger", () => {
  afterEach(async () => {
    if (ledger !== undefined) {
      await run(ledger.close());
      ledger = undefined;
    }
    if (tempDir !== undefined) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  test("does not mark acked records for resend", async () => {
    const db = await openLedger();
    const scan = await run(db.upsertSourceFile(unit, fingerprintA));
    expect(
      await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-a", scan.scanSeq)),
    ).toBe("needs_send");
    await run(db.markAcked(scan.fileId, [{ recordId: "record-a", hash: "hash-a" }]));

    expect(
      await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-a", scan.scanSeq)),
    ).toBe("unchanged");
  });

  test("marks changed content for resend", async () => {
    const db = await openLedger();
    const scan = await run(db.upsertSourceFile(unit, fingerprintA));
    await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-a", scan.scanSeq));
    await run(db.markAcked(scan.fileId, [{ recordId: "record-a", hash: "hash-a" }]));

    expect(
      await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-b", scan.scanSeq)),
    ).toBe("needs_send");
  });

  test("reprocesses interrupted files", async () => {
    const db = await openLedger();
    const first = await run(db.upsertSourceFile(unit, fingerprintA));
    expect(first).toMatchObject({ scanSeq: 1, changed: true });

    const second = await run(db.upsertSourceFile(unit, fingerprintA));
    expect(second).toMatchObject({
      fileId: first.fileId,
      scanSeq: 2,
      changed: true,
    });
  });

  test("skips complete files with matching fingerprint", async () => {
    const db = await openLedger();
    const first = await run(db.upsertSourceFile(unit, fingerprintA));
    await run(db.markFileComplete(first.fileId, first.scanSeq, fingerprintA));

    expect(await run(db.upsertSourceFile(unit, fingerprintA))).toMatchObject({
      fileId: first.fileId,
      scanSeq: first.scanSeq,
      changed: false,
    });
  });

  test("computes stale records from an exact ID-set diff", async () => {
    const db = await openLedger();
    const first = await run(db.upsertSourceFile(unit, fingerprintA));
    await run(db.recordDerivedRecord(first.fileId, "record-a", "event", "hash-a", first.scanSeq));
    await run(db.recordDerivedRecord(first.fileId, "record-b", "event", "hash-b", first.scanSeq));
    await run(db.markFileComplete(first.fileId, first.scanSeq, fingerprintA));

    const second = await run(db.upsertSourceFile(unit, fingerprintB));
    await run(db.recordDerivedRecord(second.fileId, "record-a", "event", "hash-a", second.scanSeq));
    await run(db.markFileComplete(second.fileId, second.scanSeq, fingerprintB));

    expect(await run(db.staleRecords(second.fileId, second.scanSeq))).toEqual([
      { recordId: "record-b", recordType: "event", contentHash: "hash-b" },
    ]);
  });

  test("keeps ack updates transactional", async () => {
    const db = await openLedger();
    const scan = await run(db.upsertSourceFile(unit, fingerprintA));
    await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-a", scan.scanSeq));
    await run(db.recordDerivedRecord(scan.fileId, "record-b", "event", "hash-b", scan.scanSeq));

    const error = await run(
      Effect.flip(
        db.markAcked(scan.fileId, [
          { recordId: "record-a", hash: "hash-a" },
          { recordId: "record-b", hash: "wrong-hash" },
        ]),
      ),
    );
    expect(error._tag).toBe("LedgerError");
    expect(
      await run(db.recordDerivedRecord(scan.fileId, "record-a", "event", "hash-a", scan.scanSeq)),
    ).toBe("needs_send");
  });

  test("uses exactly the three durable tables and stores no record bodies", async () => {
    const db = await openLedger();

    expect(await run(db.tableNames())).toEqual(["meta", "records", "source_files"]);
    expect(await run(db.columnNames("records"))).toEqual([
      "source_file_id",
      "record_id",
      "record_type",
      "content_hash",
      "acked_hash",
      "seen_seq",
    ]);
  });

  test("keeps provider and adapter in source identity", async () => {
    const db = await openLedger();
    const first = await run(db.upsertSourceFile(unit, fingerprintA));
    const second = await run(
      db.upsertSourceFile({ ...unit, adapterId: "opencode-db" }, fingerprintA),
    );
    const third = await run(
      db.upsertSourceFile({ ...unit, provider: "opencode" }, fingerprintA),
    );

    expect(new Set([first.fileId, second.fileId, third.fileId]).size).toBe(3);
  });
});
