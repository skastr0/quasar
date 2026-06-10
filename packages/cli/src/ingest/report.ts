import {
  recordWireBytes,
  type AdapterDiagnostic,
  type IngestRecord,
  type IngestRecordType,
  type IngestRecordsResponse,
  type RecordEnvelope,
  type UnitFingerprint,
} from "@skastr0/quasar-core";

export type RecordTypeReport = {
  readonly count: number;
  readonly wireBytes: number;
};

export type IngestReport = {
  readonly generatedAt: string;
  readonly dryRun: boolean;
  readonly elapsedMs: number;
  readonly files: {
    readonly discovered: number;
    readonly processed: number;
    readonly skipped: number;
    readonly incomplete: number;
    readonly removed: number;
    readonly unconfirmedMissing: number;
  };
  readonly records: {
    readonly derived: number;
    readonly unchanged: number;
    readonly sent: number;
    readonly tombstoned: number;
    readonly byType: Partial<Record<IngestRecordType, RecordTypeReport>>;
  };
  readonly envelopes: {
    readonly sent: number;
    readonly wireBytes: number;
    readonly serverApplied: number;
    readonly serverUnchanged: number;
    readonly serverTombstoned: number;
  };
  readonly bytes: {
    readonly source: number;
    readonly recordWire: number;
    readonly usefulText: number;
    readonly prunedEstimate: number;
    readonly maxRecord: number;
    readonly p95Record: number;
    readonly amplificationRatio: number;
  };
  readonly memory: {
    readonly rssHighWaterBytes: number;
  };
  readonly diagnostics: readonly AdapterDiagnostic[];
};

const textEncoder = new TextEncoder();

const bytesOfText = (value: string | undefined) =>
  value === undefined ? 0 : textEncoder.encode(value).byteLength;

const bytesOfJson = (value: unknown) => {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : textEncoder.encode(serialized).byteLength;
};

const percentile = (values: readonly number[], target: number) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * target) - 1));
  return sorted[index] ?? 0;
};

export class IngestReporter {
  private readonly startedAt = Date.now();
  private readonly recordTypeReports: Partial<Record<IngestRecordType, RecordTypeReport>> = {};
  private readonly recordSizes: number[] = [];
  private readonly eventUsefulTextIds = new Set<string>();
  private sourceBytes = 0;
  private recordWireTotal = 0;
  private usefulTextBytes = 0;
  private filesDiscovered = 0;
  private filesProcessed = 0;
  private filesSkipped = 0;
  private filesIncomplete = 0;
  private filesRemoved = 0;
  private unconfirmedMissingFiles = 0;
  private recordsDerived = 0;
  private recordsUnchanged = 0;
  private recordsSent = 0;
  private recordsTombstoned = 0;
  private envelopesSent = 0;
  private envelopeWireBytes = 0;
  private serverApplied = 0;
  private serverUnchanged = 0;
  private serverTombstoned = 0;
  private readonly adapterDiagnostics: AdapterDiagnostic[] = [];

  constructor(private readonly dryRun: boolean) {}

  observeUnit(fingerprint: UnitFingerprint) {
    this.filesDiscovered += 1;
    this.sourceBytes += fingerprint.size ?? 0;
  }

  observeProcessedUnit() {
    this.filesProcessed += 1;
  }

  observeSkippedUnit() {
    this.filesSkipped += 1;
  }

  observeIncompleteUnit() {
    this.filesIncomplete += 1;
  }

  observeRemovedFile() {
    this.filesRemoved += 1;
  }

  observeUnconfirmedMissingFile() {
    this.unconfirmedMissingFiles += 1;
  }

  observeRecord(record: IngestRecord) {
    const wireBytes = recordWireBytes(record);
    this.recordsDerived += 1;
    this.recordWireTotal += Number.isFinite(wireBytes) ? wireBytes : 0;
    this.recordSizes.push(Number.isFinite(wireBytes) ? wireBytes : 0);
    const existing = this.recordTypeReports[record.type] ?? { count: 0, wireBytes: 0 };
    this.recordTypeReports[record.type] = {
      count: existing.count + 1,
      wireBytes: existing.wireBytes + (Number.isFinite(wireBytes) ? wireBytes : 0),
    };
    this.observeUsefulText(record);
  }

  observeUnchangedRecord() {
    this.recordsUnchanged += 1;
  }

  observeTombstonedRecord() {
    this.recordsTombstoned += 1;
  }

  observeEnvelope(envelope: RecordEnvelope, response: IngestRecordsResponse) {
    this.envelopesSent += 1;
    this.recordsSent += envelope.records.length;
    this.envelopeWireBytes += bytesOfJson(envelope);
    this.serverApplied += response.applied;
    this.serverUnchanged += response.unchanged;
    this.serverTombstoned += response.tombstoned;
  }

  observeDiagnostic(diagnostic: AdapterDiagnostic) {
    this.adapterDiagnostics.push(diagnostic);
  }

  snapshot(rssHighWaterBytes: number): IngestReport {
    const elapsedMs = Date.now() - this.startedAt;
    const prunedEstimate = Math.max(0, this.sourceBytes - this.envelopeWireBytes);
    return {
      generatedAt: new Date().toISOString(),
      dryRun: this.dryRun,
      elapsedMs,
      files: {
        discovered: this.filesDiscovered,
        processed: this.filesProcessed,
        skipped: this.filesSkipped,
        incomplete: this.filesIncomplete,
        removed: this.filesRemoved,
        unconfirmedMissing: this.unconfirmedMissingFiles,
      },
      records: {
        derived: this.recordsDerived,
        unchanged: this.recordsUnchanged,
        sent: this.recordsSent,
        tombstoned: this.recordsTombstoned,
        byType: this.recordTypeReports,
      },
      envelopes: {
        sent: this.envelopesSent,
        wireBytes: this.envelopeWireBytes,
        serverApplied: this.serverApplied,
        serverUnchanged: this.serverUnchanged,
        serverTombstoned: this.serverTombstoned,
      },
      bytes: {
        source: this.sourceBytes,
        recordWire: this.recordWireTotal,
        usefulText: this.usefulTextBytes,
        prunedEstimate,
        maxRecord: Math.max(0, ...this.recordSizes),
        p95Record: percentile(this.recordSizes, 0.95),
        amplificationRatio:
          this.usefulTextBytes === 0 ? 0 : this.envelopeWireBytes / this.usefulTextBytes,
      },
      memory: {
        rssHighWaterBytes,
      },
      diagnostics: this.adapterDiagnostics,
    };
  }

  private observeUsefulText(record: IngestRecord) {
    if (record.type === "event") {
      const bytes = bytesOfText(record.record.contentText);
      if (bytes > 0) {
        this.eventUsefulTextIds.add(record.record.id);
        this.usefulTextBytes += bytes;
      }
      return;
    }
    if (record.type !== "content_block" || this.eventUsefulTextIds.has(record.record.eventId)) {
      return;
    }
    const bytes =
      bytesOfText(record.record.text) +
      bytesOfText(record.record.markdown) +
      bytesOfText(record.record.thinking);
    if (bytes > 0) {
      this.eventUsefulTextIds.add(record.record.eventId);
      this.usefulTextBytes += bytes;
    }
  }
}

export const startRssSampler = (intervalMs = 250) => {
  let highWater = process.memoryUsage().rss;
  const sample = () => {
    highWater = Math.max(highWater, process.memoryUsage().rss);
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
      sample();
      return highWater;
    },
  };
};
