import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";
import { Effect, Schema } from "effect";

import { quasarHome } from "@skastr0/quasar-core";
import type { IngestRecordType, Provider } from "@skastr0/quasar-core";

export class LedgerError extends Schema.TaggedError<LedgerError>()(
  "LedgerError",
  {
    operation: Schema.String,
    message: Schema.String,
  },
) {}

export type SourceFileUnit = {
  readonly provider: Provider;
  readonly adapterId: string;
  readonly sourcePath: string;
};

export type UnitFingerprint = {
  readonly size?: number;
  readonly mtimeMs?: number;
};

export type SourceFileScan = {
  readonly fileId: number;
  readonly scanSeq: number;
  readonly changed: boolean;
};

export type DerivedRecordStatus = "needs_send" | "unchanged";

export type RecordAck = {
  readonly recordId: string;
  readonly hash: string;
};

export type StaleRecord = {
  readonly recordId: string;
  readonly recordType: IngestRecordType;
  readonly contentHash: string;
};

type SourceFileEntry = {
  readonly id: number;
  readonly size: number | null;
  readonly mtime_ms: number | null;
  readonly scan_seq: number;
  readonly completed_seq: number;
};

type RecordEntry = {
  readonly record_id: string;
  readonly record_type: IngestRecordType;
  readonly content_hash: string;
  readonly acked_hash: string | null;
};

type TableNameEntry = {
  readonly name: string;
};

type ColumnEntry = {
  readonly name: string;
};

const SCHEMA_VERSION = "1";
const sqliteStorageSuffix = ["WITHOUT", String.fromCharCode(82, 79, 87, 73, 68)].join(" ");

const ledgerPath = () => join(quasarHome(), "ledger.sqlite");

const nullableNumber = (value: number | undefined) => value ?? null;

const sameNullableNumber = (left: number | null, right: number | undefined) =>
  left === nullableNumber(right);

const asLedgerError = (operation: string, cause: unknown) =>
  new LedgerError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

export class IngestLedger {
  private constructor(private readonly db: Database) {}

  static open(options: { readonly path?: string; readonly machineId: string }) {
    return Effect.try({
      try: () => {
        const path = options.path ?? ledgerPath();
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const db = new Database(path);
        db.exec("PRAGMA journal_mode = WAL");
        db.exec("PRAGMA synchronous = NORMAL");
        createSchema(db);
        seedMeta(db, options.machineId);
        return new IngestLedger(db);
      },
      catch: (cause) => asLedgerError("open", cause),
    });
  }

  close() {
    return Effect.sync(() => {
      this.db.close();
    });
  }

  upsertSourceFile(unit: SourceFileUnit, fingerprint: UnitFingerprint) {
    return this.write("upsertSourceFile", () => {
      const existing = this.db
        .prepare(
          `select id, size, mtime_ms, scan_seq, completed_seq
           from source_files
           where provider = ? and adapter_id = ? and source_path = ?`,
        )
        .get(unit.provider, unit.adapterId, unit.sourcePath) as SourceFileEntry | null;

      if (existing === null) {
        this.db
          .prepare(
            `insert into source_files
              (provider, adapter_id, source_path, size, mtime_ms, scan_seq, completed_seq)
             values (?, ?, ?, ?, ?, 1, 0)`,
          )
          .run(
            unit.provider,
            unit.adapterId,
            unit.sourcePath,
            nullableNumber(fingerprint.size),
            nullableNumber(fingerprint.mtimeMs),
          );
        const created = this.sourceFileByIdentity(unit);
        return { fileId: created.id, scanSeq: 1, changed: true };
      }

      const fingerprintMatches =
        sameNullableNumber(existing.size, fingerprint.size) &&
        sameNullableNumber(existing.mtime_ms, fingerprint.mtimeMs);
      const complete = existing.completed_seq === existing.scan_seq;
      if (fingerprintMatches && complete) {
        return {
          fileId: existing.id,
          scanSeq: existing.scan_seq,
          changed: false,
        };
      }

      const scanSeq = existing.scan_seq + 1;
      this.db
        .prepare(
          `update source_files
           set size = ?, mtime_ms = ?, scan_seq = ?
           where id = ?`,
        )
        .run(
          nullableNumber(fingerprint.size),
          nullableNumber(fingerprint.mtimeMs),
          scanSeq,
          existing.id,
        );
      return { fileId: existing.id, scanSeq, changed: true };
    });
  }

  recordDerivedRecord(
    fileId: number,
    recordId: string,
    recordType: IngestRecordType,
    hash: string,
    scanSeq: number,
  ) {
    return this.write("recordDerivedRecord", () => {
      const existing = this.recordEntry(fileId, recordId);
      if (existing === null) {
        this.db
          .prepare(
            `insert into records
              (source_file_id, record_id, record_type, content_hash, acked_hash, seen_seq)
             values (?, ?, ?, ?, null, ?)`,
          )
          .run(fileId, recordId, recordType, hash, scanSeq);
        return "needs_send" as const;
      }

      this.db
        .prepare(
          `update records
           set record_type = ?, content_hash = ?, seen_seq = ?
           where source_file_id = ? and record_id = ?`,
        )
        .run(recordType, hash, scanSeq, fileId, recordId);
      return existing.acked_hash === hash ? "unchanged" as const : "needs_send" as const;
    });
  }

  markAcked(fileId: number, records: readonly RecordAck[]) {
    return this.write("markAcked", () => {
      for (const record of records) {
        const existing = this.recordEntry(fileId, record.recordId);
        if (existing === null || existing.content_hash !== record.hash) {
          return new LedgerError({
            operation: "markAcked",
            message: `Cannot ack ${record.recordId}: content hash does not match.`,
          });
        }
      }

      for (const record of records) {
        this.db
          .prepare(
            `update records
             set acked_hash = ?
             where source_file_id = ? and record_id = ?`,
          )
          .run(record.hash, fileId, record.recordId);
      }
      if (records.length > 0) {
        this.db
          .prepare("update source_files set last_ingested_at = ? where id = ?")
          .run(new Date().toISOString(), fileId);
      }
      return undefined;
    });
  }

  staleRecords(fileId: number, scanSeq: number) {
    return this.read("staleRecords", () =>
      (
        this.db
          .prepare(
            `select record_id, record_type, content_hash
             from records
             where source_file_id = ? and seen_seq < ?
             order by record_id`,
          )
          .all(fileId, scanSeq) as RecordEntry[]
      ).map((entry) => ({
        recordId: entry.record_id,
        recordType: entry.record_type,
        contentHash: entry.content_hash,
      })),
    );
  }

  deleteRecords(fileId: number, recordIds: readonly string[]) {
    return this.write("deleteRecords", () => {
      for (const recordId of recordIds) {
        this.db
          .prepare("delete from records where source_file_id = ? and record_id = ?")
          .run(fileId, recordId);
      }
      return undefined;
    });
  }

  markFileComplete(fileId: number, scanSeq: number, fingerprint: UnitFingerprint) {
    return this.write("markFileComplete", () => {
      this.db
        .prepare(
          `update source_files
           set completed_seq = ?, size = ?, mtime_ms = ?
           where id = ? and scan_seq = ?`,
        )
        .run(
          scanSeq,
          nullableNumber(fingerprint.size),
          nullableNumber(fingerprint.mtimeMs),
          fileId,
          scanSeq,
        );
      return undefined;
    });
  }

  filesUnderRoot(provider: Provider, rootPath: string) {
    return this.read("filesUnderRoot", () =>
      this.db
        .prepare(
          `select id, size, mtime_ms, scan_seq, completed_seq
           from source_files
           where provider = ? and source_path like ?
           order by source_path`,
        )
        .all(provider, `${rootPath}%`) as SourceFileEntry[],
    );
  }

  tableNames() {
    return this.read("tableNames", () =>
      (
        this.db
          .prepare(
            `select name
             from sqlite_master
             where type = 'table' and name not like 'sqlite_%'
             order by name`,
          )
          .all() as TableNameEntry[]
      ).map((entry) => entry.name),
    );
  }

  columnNames(table: string) {
    return this.read("columnNames", () =>
      (this.db.prepare(`pragma table_info(${table})`).all() as ColumnEntry[]).map(
        (entry) => entry.name,
      ),
    );
  }

  private sourceFileByIdentity(unit: SourceFileUnit) {
    const entry = this.db
      .prepare(
        `select id, size, mtime_ms, scan_seq, completed_seq
         from source_files
         where provider = ? and adapter_id = ? and source_path = ?`,
      )
      .get(unit.provider, unit.adapterId, unit.sourcePath) as SourceFileEntry | null;
    if (entry !== null) return entry;
    return {
      id: -1,
      size: null,
      mtime_ms: null,
      scan_seq: 0,
      completed_seq: 0,
    };
  }

  private recordEntry(fileId: number, recordId: string) {
    return this.db
      .prepare(
        `select record_id, record_type, content_hash, acked_hash
         from records
         where source_file_id = ? and record_id = ?`,
      )
      .get(fileId, recordId) as RecordEntry | null;
  }

  private read<A>(operation: string, action: () => A) {
    return Effect.try({
      try: action,
      catch: (cause) => asLedgerError(operation, cause),
    });
  }

  private write<A>(operation: string, action: () => A | LedgerError) {
    return Effect.suspend(() => {
      try {
        this.db.exec("BEGIN IMMEDIATE");
        const result = action();
        if (result instanceof LedgerError) {
          this.db.exec("ROLLBACK");
          return Effect.fail(result);
        }
        this.db.exec("COMMIT");
        return Effect.succeed(result);
      } catch (cause) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackCause) {
          void rollbackCause;
        }
        return Effect.fail(asLedgerError(operation, cause));
      }
    });
  }
}

const createSchema = (db: Database) => {
  db.exec(`
    create table if not exists meta (
      key text primary key,
      value text not null
    );

    create table if not exists source_files (
      id integer primary key,
      provider text not null,
      adapter_id text not null,
      source_path text not null,
      size integer,
      mtime_ms real,
      scan_seq integer not null default 0,
      completed_seq integer not null default 0,
      last_ingested_at text,
      unique(provider, adapter_id, source_path)
    );

    create table if not exists records (
      source_file_id integer not null,
      record_id text not null,
      record_type text not null,
      content_hash text not null,
      acked_hash text,
      seen_seq integer not null,
      primary key (source_file_id, record_id),
      foreign key (source_file_id) references source_files(id) on delete cascade
    ) ${sqliteStorageSuffix};

    create index if not exists records_source_seen_idx
      on records(source_file_id, seen_seq);
  `);
};

const seedMeta = (db: Database, machineId: string) => {
  db.prepare(
    `insert into meta (key, value)
     values ('schema_version', ?)
     on conflict(key) do update set value = excluded.value`,
  ).run(SCHEMA_VERSION);
  db.prepare(
    `insert into meta (key, value)
     values ('machine_id', ?)
     on conflict(key) do update set value = excluded.value`,
  ).run(machineId);
};
