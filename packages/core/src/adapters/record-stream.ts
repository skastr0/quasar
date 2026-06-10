import { statSync } from "node:fs";

import {
  sessionToRecords,
  type IngestRecord,
} from "../records";
import type { NormalizedSession, SourceRoot } from "../schemas";
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
  session: NormalizedSession,
  sourceUnit: SourceUnit | undefined,
): SourceUnit | undefined => {
  if (sourceUnit !== undefined) return sourceUnit;
  return {
    provider: session.provider,
    adapterId: adapter.id,
    rootPath: session.sourceRoot,
    sourcePath: session.sourcePath,
    physicalPath: session.sourcePath,
  };
};

const sourceUnitKey = (unit: SourceUnit) =>
  `${unit.provider}\0${unit.adapterId}\0${unit.sourcePath}`;

const diagnosticFromError = (
  adapter: SessionAdapter,
  unit: SourceUnit,
  message: string,
  cause: unknown,
) => ({
  type: "diagnostic" as const,
  diagnostic: {
    adapterId: adapter.id,
    provider: adapter.provider,
    status: "error" as const,
    parserConfidence: "observed" as const,
    rootPath: unit.rootPath,
    message,
    details: { error: cause instanceof Error ? cause.message : String(cause) },
  },
});

async function* bridgeRecordStream(
  adapter: SessionAdapter,
  options: RecordStreamOptions,
): AsyncGenerator<RecordStreamItem> {
  if (adapter.stream === undefined) {
    yield {
      type: "diagnostic" as const,
      diagnostic: {
        adapterId: adapter.id,
        provider: adapter.provider,
        status: "unsupported" as const,
        message: "Adapter must expose a session stream before records can be streamed.",
      },
    };
    return;
  }

  const stream = adapter.stream(options);
  const roots = new Map<string, SourceRoot>();
  let activeUnit: SourceUnit | undefined;
  let activeFingerprint: UnitFingerprint | undefined;
  let activeShouldProcess = false;
  let activeComplete = true;

  const flushUnit = async function* () {
    if (activeUnit === undefined || activeFingerprint === undefined) return;
    yield { type: "unitEnd" as const, unit: activeUnit, complete: activeComplete };
    activeUnit = undefined;
    activeFingerprint = undefined;
    activeShouldProcess = false;
    activeComplete = true;
  };

  const startUnit = async function* (unit: SourceUnit, fingerprint: UnitFingerprint) {
    activeUnit = unit;
    activeFingerprint = fingerprint;
    activeShouldProcess = false;
    activeComplete = true;
    yield { type: "unitStart" as const, unit, fingerprint };
    try {
      activeShouldProcess = await shouldProcessSourceUnit(options, unit, fingerprint);
    } catch (cause) {
      activeComplete = false;
      yield diagnosticFromError(adapter, unit, "Record stream source-unit predicate failed.", cause);
    }
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

    const sourceUnit = sourceUnitForSession(adapter, item.session, item.sourceUnit);
    if (sourceUnit === undefined) {
      continue;
    }
    const key = sourceUnitKey(sourceUnit);
    const activeKey = activeUnit === undefined ? undefined : sourceUnitKey(activeUnit);
    if (activeUnit !== undefined && key !== activeKey) {
      yield* flushUnit();
    }
    if (activeUnit === undefined) {
      yield* startUnit(sourceUnit, item.fingerprint ?? fileFingerprint(sourceUnit.physicalPath));
    }
    if (activeShouldProcess) {
      for (const record of sessionToRecords(item.session)) {
        yield { type: "record" as const, item: record };
      }
    }
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
