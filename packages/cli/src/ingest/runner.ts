import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import {
  allAdapters,
  clampOversizedRecord,
  decodeRecordEnvelope,
  loadMachineIdentity,
  packRecordEnvelopes,
  RECORD_LIMITS,
  RECORD_PROTOCOL,
  recordContentHash,
  recordId,
  recordWireBytes,
  recordStreamFor,
  stableAdapters,
  type AdapterDiagnostic,
  type IngestRecord,
  type IngestRecordType,
  type MachineIdentity,
  type Provider,
  type RecordStreamItem,
  type RecordEnvelope,
  type SessionAdapter,
  type SourceRoot,
  type SourceUnit,
  type TombstoneRecordType,
  type UnitFingerprint,
} from "@skastr0/quasar-core";

import { IngestLedger, type RecordAck, type SourceFileUnit, type StaleRecord } from "../ledger";
import type { IngestOptions } from "../protocol";
import { IngestReporter, startRssSampler, type IngestReport } from "./report";
import { dryRunRecordSender, liveRecordSender, type RecordEnvelopeSender } from "./sender";

export class IngestRunError extends Schema.TaggedError<IngestRunError>()(
  "IngestRunError",
  {
    reason: Schema.Literal(
      "adapter_stream_failed",
      "invalid_record_envelope",
      "missing_source_unit",
      "pack_invariant_failed",
      "response_count_mismatch",
      "unsupported_tombstone_type",
    ),
    message: Schema.String,
  },
) {}

export type RunIngestOverrides = {
  readonly adapters?: readonly SessionAdapter[];
  readonly ledgerPath?: string;
  readonly machine?: MachineIdentity;
  readonly now?: string;
  readonly sender?: RecordEnvelopeSender<unknown, unknown>;
  readonly rssSampleIntervalMs?: number;
};

type UnitScanState = {
  readonly unit: SourceUnit;
  readonly fingerprint: UnitFingerprint;
  readonly fileId: number;
  readonly scanSeq: number;
  readonly shouldProcess: boolean;
};

type LedgerLease = {
  readonly path?: string;
  readonly cleanup: Effect.Effect<void>;
};

type PendingEnvelopeItem =
  | {
      readonly kind: "live";
      readonly fileId: number;
      readonly recordId: string;
      readonly hash: string;
      readonly record: IngestRecord;
      readonly wireBytes: number;
    }
  | {
      readonly kind: "tombstone";
      readonly fileId: number;
      readonly recordId: string;
      readonly record: IngestRecord;
      readonly wireBytes: number;
    };

const tombstoneRecordTypes: readonly TombstoneRecordType[] = [
  "session",
  "event",
  "content_block",
  "tool_call",
  "usage",
  "artifact",
  "edge",
  "source_root",
];

const isTombstoneRecordType = (type: IngestRecordType): type is TombstoneRecordType =>
  tombstoneRecordTypes.includes(type as TombstoneRecordType);

const sourceFileKey = (unit: Pick<SourceFileUnit, "provider" | "adapterId" | "sourcePath">) =>
  `${unit.provider}\0${unit.adapterId}\0${unit.sourcePath}`;

const adapterKey = (provider: Provider, adapterId: string) => `${provider}\0${adapterId}`;

const sourceRootKey = (provider: Provider, adapterId: string, rootPath: string) =>
  `${provider}\0${adapterId}\0${rootPath}`;

const ledgerLeaseFor = (
  dryRun: boolean,
  overridePath: string | undefined,
): Effect.Effect<LedgerLease> =>
  Effect.sync(() => {
    if (!dryRun || overridePath !== undefined) {
      return {
        path: overridePath,
        cleanup: Effect.void,
      };
    }
    const directory = mkdtempSync(join(tmpdir(), "qsr-"));
    return {
      path: join(directory, "ledger.sqlite"),
      cleanup: Effect.sync(() => {
        rmSync(directory, { recursive: true, force: true });
      }),
    };
  });

const sourceFileUnit = (unit: SourceUnit): SourceFileUnit => ({
  provider: unit.provider,
  adapterId: unit.adapterId,
  sourcePath: unit.sourcePath,
  ...(unit.physicalPath !== undefined ? { physicalPath: unit.physicalPath } : {}),
});

const sourceRootUnit = (root: SourceRoot): SourceFileUnit => ({
  provider: root.provider,
  adapterId: root.adapterId,
  sourcePath: root.rootPath,
});

const envelopeOverheadBytes = (machine: MachineIdentity) => {
  const prefix = `{"protocol":${JSON.stringify(RECORD_PROTOCOL)},"machine":${JSON.stringify(machine)},"records":[`;
  const suffix = "]}";
  return new TextEncoder().encode(`${prefix}${suffix}`).byteLength;
};

const selectAdapters = (
  providers: readonly Provider[] | undefined,
  includeExperimental: boolean,
  overrides: readonly SessionAdapter[] | undefined,
) => {
  const candidates = overrides ?? (includeExperimental ? allAdapters : stableAdapters);
  if (providers === undefined || providers.length === 0) return candidates;
  const selected = new Set<Provider>(providers);
  return candidates.filter((adapter) => selected.has(adapter.provider));
};

const tombstoneFor = (record: StaleRecord): Effect.Effect<IngestRecord, IngestRunError> => {
  if (!isTombstoneRecordType(record.recordType)) {
    return Effect.fail(
      new IngestRunError({
        reason: "unsupported_tombstone_type",
        message: `Cannot tombstone record type: ${record.recordType}`,
      }),
    );
  }
  return Effect.succeed({
    type: "tombstone",
    record: {
      recordType: record.recordType,
      recordId: record.recordId,
    },
  });
};

const envelopeCountFor = (items: readonly PendingEnvelopeItem[]) => {
  let live = 0;
  let tombstone = 0;
  for (const item of items) {
    if (item.kind === "live") live += 1;
    else tombstone += 1;
  }
  return { live, tombstone };
};

const rememberRecord = (
  reporter: IngestReporter,
  record: IngestRecord,
) => {
  reporter.observeRecord(record);
  return {
    record,
    recordId: recordId(record),
    hash: recordContentHash(record),
  };
};

class IngestRunState {
  private readonly unitScans = new Map<string, UnitScanState>();
  private readonly seenSourceFiles = new Set<string>();
  private readonly blockedRootKeys = new Set<string>();
  private readonly blockedAdapterKeys = new Set<string>();
  private pending: PendingEnvelopeItem[] = [];
  private pendingRecordWireBytes = 0;
  private readonly pendingEnvelopeOverheadBytes: number;
  private activeUnitKey: string | undefined;
  private predicateFailure: unknown;

  constructor(
    private readonly ledger: IngestLedger,
    private readonly machine: MachineIdentity,
    private readonly sender: RecordEnvelopeSender<unknown, unknown>,
    private readonly reporter: IngestReporter,
  ) {
    this.pendingEnvelopeOverheadBytes = envelopeOverheadBytes(machine);
  }

  shouldProcessUnit = async (unit: SourceUnit, fingerprint: UnitFingerprint) => {
    try {
      return await Effect.runPromise(this.shouldProcessUnitEffect(unit, fingerprint));
    } catch (cause) {
      this.predicateFailure = cause;
      throw cause;
    }
  };

  processAdapter(adapter: SessionAdapter, options: IngestOptions, machine: MachineIdentity, now: string) {
    const self = this;
    return Effect.gen(function* () {
      const stream = recordStreamFor(adapter)({
        machine,
        now,
        limit: options.limit,
        skip: options.skip,
        roots: options.roots,
        logicalRoots: options.logicalRoots,
        shouldProcessUnit: self.shouldProcessUnit,
      });
      const iterator: AsyncIterator<RecordStreamItem> = stream[Symbol.asyncIterator]();
      const closeIterator = Effect.tryPromise({
        try: async () => {
          await iterator.return?.();
        },
        catch: () =>
          new IngestRunError({
            reason: "adapter_stream_failed",
            message: "Adapter stream could not be closed.",
          }),
      }).pipe(Effect.catchAll(() => Effect.void));

      const loop = Effect.gen(function* () {
        while (true) {
          const next = yield* Effect.tryPromise({
            try: () => iterator.next(),
            catch: (cause) =>
              new IngestRunError({
                reason: "adapter_stream_failed",
                message: cause instanceof Error ? cause.message : String(cause),
              }),
          });
          if (next.done === true) break;
          const item = next.value;
          switch (item.type) {
            case "unitStart":
              self.activeUnitKey = sourceFileKey(item.unit);
              self.reporter.observeUnit(item.fingerprint);
              break;
            case "record":
              if (item.item.type === "source_root") {
                yield* self.handleSourceRoot(item.item);
              } else if (item.item.type === "tombstone") {
                return yield* new IngestRunError({
                  reason: "adapter_stream_failed",
                  message: "Adapters must not emit tombstone records.",
                });
              } else {
                yield* self.handleLiveRecord(item.item);
              }
              break;
            case "unitEnd":
              yield* self.handleUnitEnd(item.unit, item.complete);
              break;
            case "rootScanned":
              yield* self.handleRootScanned(item.root, item.complete);
              break;
            case "diagnostic":
              self.handleDiagnostic(item.diagnostic);
              break;
          }
        }
        if (self.predicateFailure !== undefined) {
          return yield* Effect.fail(
            self.predicateFailure instanceof Error
              ? self.predicateFailure
              : new IngestRunError({
                  reason: "adapter_stream_failed",
                  message: String(self.predicateFailure),
                }),
          );
        }
        yield* self.flushPending();
      });

      yield* loop.pipe(Effect.ensuring(closeIterator));
    });
  }

  private handleDiagnostic(diagnostic: AdapterDiagnostic) {
    this.reporter.observeDiagnostic(diagnostic);
    if (diagnostic.status !== "error" && diagnostic.status !== "unsupported") return;
    if (diagnostic.rootPath !== undefined) {
      this.blockedRootKeys.add(
        sourceRootKey(diagnostic.provider, diagnostic.adapterId, diagnostic.rootPath),
      );
    } else {
      this.blockedAdapterKeys.add(adapterKey(diagnostic.provider, diagnostic.adapterId));
    }
  }

  private rootHasFatalDiagnostic(root: SourceRoot) {
    return (
      this.blockedAdapterKeys.has(adapterKey(root.provider, root.adapterId)) ||
      this.blockedRootKeys.has(sourceRootKey(root.provider, root.adapterId, root.rootPath))
    );
  }

  private shouldProcessUnitEffect(unit: SourceUnit, fingerprint: UnitFingerprint) {
    const self = this;
    return Effect.gen(function* () {
      const scan = yield* self.ledger.upsertSourceFile(sourceFileUnit(unit), fingerprint);
      const key = sourceFileKey(unit);
      const pending = yield* self.ledger.pendingRecords(scan.fileId);
      const shouldProcess = scan.changed || pending.length > 0;
      self.seenSourceFiles.add(key);
      self.unitScans.set(key, {
        unit,
        fingerprint,
        fileId: scan.fileId,
        scanSeq: scan.scanSeq,
        shouldProcess,
      });
      if (shouldProcess) self.reporter.observeProcessedUnit();
      else self.reporter.observeSkippedUnit();
      return shouldProcess;
    });
  }

  private handleSourceRoot(record: Extract<IngestRecord, { type: "source_root" }>) {
    const self = this;
    return Effect.gen(function* () {
      const unit = sourceRootUnit(record.record);
      const key = sourceFileKey(unit);
      self.seenSourceFiles.add(key);
      const scan = yield* self.ledger.upsertSourceFile(unit, {});
      const normalized = clampOversizedRecord(record);
      const remembered = rememberRecord(self.reporter, normalized);
      const status = yield* self.ledger.recordDerivedRecord(
        scan.fileId,
        remembered.recordId,
        normalized.type,
        remembered.hash,
        scan.scanSeq,
      );
      if (status === "unchanged") {
        self.reporter.observeUnchangedRecord();
      } else {
        yield* self.addPending({
          kind: "live",
          fileId: scan.fileId,
          recordId: remembered.recordId,
          hash: remembered.hash,
          record: normalized,
          wireBytes: recordWireBytes(normalized),
        });
      }
      yield* self.flushPending();
      yield* self.sendTombstones(scan.fileId, yield* self.ledger.staleRecords(scan.fileId, scan.scanSeq));
      yield* self.ledger.markFileComplete(scan.fileId, scan.scanSeq, {});
    });
  }

  private handleLiveRecord(record: Exclude<IngestRecord, { type: "source_root" | "tombstone" }>) {
    const self = this;
    return Effect.gen(function* () {
      if (self.activeUnitKey === undefined) {
        return yield* new IngestRunError({
          reason: "missing_source_unit",
          message: "Adapter emitted a live record outside a source unit.",
        });
      }
      const scan = self.unitScans.get(self.activeUnitKey);
      if (scan === undefined || !scan.shouldProcess) {
        return yield* new IngestRunError({
          reason: "missing_source_unit",
          message: "Adapter emitted a live record before source-unit processing was accepted.",
        });
      }

      const normalized = clampOversizedRecord(record);
      const remembered = rememberRecord(self.reporter, normalized);
      const status = yield* self.ledger.recordDerivedRecord(
        scan.fileId,
        remembered.recordId,
        normalized.type,
        remembered.hash,
        scan.scanSeq,
      );
      if (status === "unchanged") {
        self.reporter.observeUnchangedRecord();
        return;
      }
      yield* self.addPending({
        kind: "live",
        fileId: scan.fileId,
        recordId: remembered.recordId,
        hash: remembered.hash,
        record: normalized,
        wireBytes: recordWireBytes(normalized),
      });
    });
  }

  private handleUnitEnd(unit: SourceUnit, complete: boolean) {
    const self = this;
    return Effect.gen(function* () {
      const key = sourceFileKey(unit);
      const scan = self.unitScans.get(key);
      self.activeUnitKey = undefined;
      if (scan === undefined) {
        if (!complete) self.reporter.observeIncompleteUnit();
        self.reporter.finishUnit();
        return;
      }
      if (!complete) {
        self.reporter.observeIncompleteUnit();
        self.dropPendingForFile(scan.fileId);
        self.reporter.finishUnit();
        return;
      }
      if (!scan.shouldProcess) {
        self.reporter.finishUnit();
        return;
      }
      yield* self.flushPending();
      yield* self.sendTombstones(scan.fileId, yield* self.ledger.staleRecords(scan.fileId, scan.scanSeq));
      yield* self.ledger.markFileComplete(scan.fileId, scan.scanSeq, scan.fingerprint);
      self.reporter.finishUnit();
    });
  }

  private handleRootScanned(root: SourceRoot, complete: boolean) {
    const self = this;
    return Effect.gen(function* () {
      if (!complete || self.rootHasFatalDiagnostic(root)) return;
      const files = yield* self.ledger.filesUnderRoot(root.provider, root.adapterId, root.rootPath);
      for (const file of files) {
        if (self.seenSourceFiles.has(sourceFileKey(file))) continue;
        if (file.physicalPath === undefined || file.physicalPath.length === 0) {
          self.reporter.observeUnconfirmedMissingFile();
          continue;
        }
        if (existsSync(file.physicalPath)) continue;
        yield* self.flushPending();
        yield* self.sendTombstones(file.fileId, yield* self.ledger.recordsForFile(file.fileId));
        yield* self.ledger.deleteSourceFile(file.fileId);
        self.reporter.observeRemovedFile();
      }
    });
  }

  private addPending(item: PendingEnvelopeItem) {
    const self = this;
    return Effect.gen(function* () {
      if (self.pending.length > 0 && !self.canAppendPending(item)) {
        yield* self.flushPending();
      }
      self.pending = [...self.pending, item];
      self.pendingRecordWireBytes += item.wireBytes;
    });
  }

  private flushPending() {
    const self = this;
    return Effect.gen(function* () {
      if (self.pending.length === 0) return;
      const pending = self.pending;
      self.pending = [];
      self.pendingRecordWireBytes = 0;
      const envelopes = yield* packRecordEnvelopes({
        machine: self.machine,
        records: pending.map((item) => item.record),
      });
      let offset = 0;
      for (const envelope of envelopes) {
        const validatedEnvelope = yield* decodeRecordEnvelope(envelope).pipe(
          Effect.mapError(
            (error) =>
              new IngestRunError({
                reason: "invalid_record_envelope",
                message: error.message,
              }),
          ),
        );
        const items = pending.slice(offset, offset + validatedEnvelope.records.length);
        offset += validatedEnvelope.records.length;
        yield* self.sendEnvelope(validatedEnvelope, items);
      }
    });
  }

  private sendEnvelope(envelope: RecordEnvelope, pending: readonly PendingEnvelopeItem[]) {
    const self = this;
    return Effect.gen(function* () {
      const response = yield* self.sender.send(envelope);
      yield* self.validateResponseCounts(response, pending);
      self.reporter.observeEnvelope(envelope, response);
      const liveByFile = new Map<number, RecordAck[]>();
      const tombstonesByFile = new Map<number, string[]>();
      for (const item of pending) {
        if (item.kind === "live") {
          const records = liveByFile.get(item.fileId) ?? [];
          records.push({ recordId: item.recordId, hash: item.hash });
          liveByFile.set(item.fileId, records);
        } else {
          const records = tombstonesByFile.get(item.fileId) ?? [];
          records.push(item.recordId);
          tombstonesByFile.set(item.fileId, records);
          self.reporter.observeTombstonedRecord();
        }
      }
      for (const [fileId, records] of liveByFile) {
        yield* self.ledger.markAcked(fileId, records);
      }
      for (const [fileId, recordIds] of tombstonesByFile) {
        yield* self.ledger.deleteRecords(fileId, recordIds);
      }
    });
  }

  private sendTombstones(fileId: number, records: readonly StaleRecord[]) {
    const self = this;
    return Effect.gen(function* () {
      if (records.length === 0) return;
      yield* self.flushPending();
      for (const record of records) {
        const tombstone = yield* tombstoneFor(record);
        self.reporter.observeRecord(tombstone);
        yield* self.addPending({
          kind: "tombstone",
          fileId,
          recordId: record.recordId,
          record: tombstone,
          wireBytes: recordWireBytes(tombstone),
        });
      }
      yield* self.flushPending();
    });
  }

  private canAppendPending(item: PendingEnvelopeItem) {
    const count = this.pending.length + 1;
    if (count > RECORD_LIMITS.maxRecordsPerEnvelope) return false;
    const separators = Math.max(0, count - 1);
    const bytes = this.pendingEnvelopeOverheadBytes +
      this.pendingRecordWireBytes +
      item.wireBytes +
      separators;
    return Number.isFinite(bytes) && bytes <= RECORD_LIMITS.maxEnvelopeBytes;
  }

  private dropPendingForFile(fileId: number) {
    this.pending = this.pending.filter((item) => item.fileId !== fileId);
    this.pendingRecordWireBytes = this.pending.reduce(
      (total, item) => total + item.wireBytes,
      0,
    );
  }

  private validateResponseCounts(
    response: { readonly applied: number; readonly unchanged: number; readonly tombstoned: number },
    pending: readonly PendingEnvelopeItem[],
  ) {
    const { live, tombstone } = envelopeCountFor(pending);
    const total = live + tombstone;
    const acknowledged = response.applied + response.unchanged + response.tombstoned;
    if (
      acknowledged !== total ||
      response.applied > live ||
      response.tombstoned > tombstone
    ) {
      return Effect.fail(
        new IngestRunError({
          reason: "response_count_mismatch",
          message: `Ingest response acknowledged total=${acknowledged}/${total}, applied=${response.applied}/${live}, tombstones=${response.tombstoned}/${tombstone}.`,
        }),
      );
    }
    return Effect.void;
  }
}

export const runIngest = (options: IngestOptions, overrides: RunIngestOverrides = {}) =>
  Effect.gen(function* () {
    const dryRun = options.dryRun ?? true;
    const machine = overrides.machine ?? loadMachineIdentity();
    const now = overrides.now ?? new Date().toISOString();
    const adapters = selectAdapters(
      options.providers,
      options.includeExperimental ?? false,
      overrides.adapters,
    );
    const sender = overrides.sender ?? (dryRun ? dryRunRecordSender : liveRecordSender);
    const reporter = new IngestReporter(dryRun);
    const sampler = startRssSampler(overrides.rssSampleIntervalMs);
    const ledgerLease = yield* ledgerLeaseFor(dryRun, overrides.ledgerPath);
    const ledger = yield* IngestLedger.open({
      path: ledgerLease.path,
      machineId: machine.machineId,
    });
    const state = new IngestRunState(ledger, machine, sender, reporter);
    const cleanup = ledger.close().pipe(
      Effect.catchAll(() => Effect.void),
      Effect.zipRight(ledgerLease.cleanup.pipe(Effect.catchAll(() => Effect.void))),
    );
    const program = Effect.gen(function* () {
      for (const adapter of adapters) {
        yield* state.processAdapter(adapter, options, machine, now);
      }
      return reporter.snapshot(sampler.stop());
    });
    return yield* program.pipe(
      Effect.tapError(() => Effect.sync(() => sampler.stop())),
      Effect.ensuring(cleanup),
    );
  });
