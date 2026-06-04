import { hostname, platform } from "node:os";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stableWideHash } from "./hash";
import { allAdapters, readAdapters, stableAdapters } from "./adapters/registry";
import type { AdapterReadResult } from "./adapters/types";
import type { IngestBatch, MachineIdentity, Provider } from "./schemas";

export const quasarHome = () =>
  process.env.QUASAR_HOME ??
  (process.env.HOME === undefined
    ? ".quasar"
    : join(process.env.HOME, ".config", "quasar"));

const machinePath = () => join(quasarHome(), "machine.json");

export const loadMachineIdentity = (): MachineIdentity => {
  mkdirSync(quasarHome(), { recursive: true, mode: 0o700 });
  try {
    const existing = JSON.parse(readFileSync(machinePath(), "utf8")) as MachineIdentity;
    if (existing.machineId) return existing;
  } catch {
    // Create a new stable local identity below.
  }
  const machine: MachineIdentity = {
    machineId: `machine:${stableWideHash(`${hostname()}:${Date.now()}:${Math.random()}`)}`,
    hostname: hostname(),
    platform: platform(),
  };
  writeFileSync(machinePath(), JSON.stringify(machine, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  return machine;
};

export interface BuildIngestBatchOptions {
  readonly providers?: readonly Provider[];
  readonly includeExperimental?: boolean;
  readonly limit?: number;
  readonly roots?: Partial<Record<Provider, string>>;
  readonly machine?: MachineIdentity;
}

export const buildIngestBatch = async (
  options: BuildIngestBatchOptions = {},
): Promise<IngestBatch> => {
  const machine = options.machine ?? loadMachineIdentity();
  const adapters = (options.includeExperimental ? allAdapters : stableAdapters).filter(
    (adapter) =>
      options.providers === undefined || options.providers.includes(adapter.provider),
  );
  const now = new Date().toISOString();
  const result: AdapterReadResult = await readAdapters(adapters, {
    machine,
    now,
    roots: options.roots,
    limit: options.limit,
  });
  return {
    protocolVersion: "quasar.ingest/v1",
    machine,
    sourceRoots: result.sourceRoots,
    sessions: result.sessions,
    diagnostics: result.diagnostics,
    generatedAt: now,
  };
};

export const summarizeBatch = (batch: IngestBatch) => ({
  machine: batch.machine,
  generatedAt: batch.generatedAt,
  sourceRootCount: batch.sourceRoots.length,
  sessionCount: batch.sessions.length,
  eventCount: batch.sessions.reduce((sum, session) => sum + session.events.length, 0),
  toolCallCount: batch.sessions.reduce(
    (sum, session) => sum + session.toolCalls.length,
    0,
  ),
  diagnostics: batch.diagnostics,
});
