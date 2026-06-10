import { statSync } from "node:fs";

import {
  sessionToRecords,
  type IngestRecord,
} from "../records";
import type { SourceRoot } from "../schemas";
import type {
  AdapterStreamItem,
  RecordStreamItem,
  RecordStreamOptions,
  SessionAdapter,
  SourceUnit,
  UnitFingerprint,
} from "./types";

const sourceRootRecord = (record: SourceRoot): IngestRecord => ({
  type: "source_root",
  record,
});

export const shouldProcessSourceUnit = async (
  options: Pick<RecordStreamOptions, "shouldProcessUnit">,
  unit: SourceUnit,
  fingerprint: UnitFingerprint,
) =>
  options.shouldProcessUnit === undefined ||
  options.shouldProcessUnit(unit, fingerprint);

const fileFingerprint = (path: string | undefined): UnitFingerprint => {
  if (path === undefined) return {};
  try {
    const stats = statSync(path);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch (cause) {
    void cause;
    return {};
  }
};

const sourceUnitForSession = (
  adapter: SessionAdapter,
  records: readonly IngestRecord[],
): SourceUnit | undefined => {
  const session = records.find(
    (record): record is Extract<IngestRecord, { readonly type: "session" }> =>
      record.type === "session",
  );
  if (session === undefined) return undefined;
  return {
    provider: session.record.provider,
    adapterId: adapter.id,
    rootPath: session.record.sourceRoot,
    sourcePath: session.record.sourcePath,
    physicalPath: session.record.sourcePath,
  };
};

async function* streamFromReadResult(
  adapter: SessionAdapter,
  options: RecordStreamOptions,
): AsyncGenerator<AdapterStreamItem> {
  const result = await adapter.read(options);
  for (const sourceRoot of result.sourceRoots) {
    yield { type: "sourceRoot", sourceRoot };
  }
  for (const session of result.sessions) {
    yield { type: "session", session };
  }
  for (const diagnostic of result.diagnostics) {
    yield { type: "diagnostic", diagnostic };
  }
}

async function* bridgeRecordStream(
  adapter: SessionAdapter,
  options: RecordStreamOptions,
): AsyncGenerator<RecordStreamItem> {
  const stream = adapter.stream?.(options) ?? streamFromReadResult(adapter, options);
  const roots = new Map<string, SourceRoot>();
  let activeUnit: SourceUnit | undefined;
  let activeFingerprint: UnitFingerprint | undefined;
  let activeRecords: IngestRecord[] = [];

  const flushUnit = async function* () {
    if (activeUnit === undefined || activeFingerprint === undefined) return;
    yield { type: "unitStart" as const, unit: activeUnit, fingerprint: activeFingerprint };
    const shouldProcess = await shouldProcessSourceUnit(
      options,
      activeUnit,
      activeFingerprint,
    );
    if (shouldProcess) {
      for (const record of activeRecords) {
        yield { type: "record" as const, item: record };
      }
    }
    yield { type: "unitEnd" as const, unit: activeUnit, complete: true };
    activeUnit = undefined;
    activeFingerprint = undefined;
    activeRecords = [];
  };

  for await (const item of stream) {
    if (item.type === "diagnostic") {
      yield item;
      continue;
    }
    if (item.type === "sourceRoot") {
      roots.set(item.sourceRoot.rootPath, item.sourceRoot);
      yield { type: "record", item: sourceRootRecord(item.sourceRoot) };
      continue;
    }

    const records = sessionToRecords(item.session);
    const sourceUnit = sourceUnitForSession(adapter, records);
    if (sourceUnit === undefined) {
      continue;
    }
    const key = `${sourceUnit.provider}\0${sourceUnit.adapterId}\0${sourceUnit.sourcePath}`;
    const activeKey =
      activeUnit === undefined
        ? undefined
        : `${activeUnit.provider}\0${activeUnit.adapterId}\0${activeUnit.sourcePath}`;
    if (activeUnit !== undefined && key !== activeKey) {
      yield* flushUnit();
    }
    if (activeUnit === undefined) {
      activeUnit = sourceUnit;
      activeFingerprint = fileFingerprint(sourceUnit.physicalPath);
      activeRecords = [];
    }
    activeRecords.push(...records);
  }

  yield* flushUnit();
  for (const root of roots.values()) {
    yield { type: "rootScanned" as const, root, complete: true };
  }
}

export const recordStreamFor =
  (adapter: SessionAdapter) =>
  (options: RecordStreamOptions): AsyncIterable<RecordStreamItem> =>
    adapter.streamRecords?.(options) ?? bridgeRecordStream(adapter, options);
