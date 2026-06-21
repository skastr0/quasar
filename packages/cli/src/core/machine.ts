import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { join } from "node:path";

import { stableWideHash } from "./hash";
import type { MachineIdentity } from "./schemas";

export const quasarHome = () =>
  process.env.QUASAR_HOME ??
  (process.env.HOME === undefined
    ? ".quasar"
    : join(process.env.HOME, ".config", "quasar"));

const machinePath = () => join(quasarHome(), "machine.json");

export const loadMachineIdentity = (): MachineIdentity => {
  mkdirSync(quasarHome(), { recursive: true, mode: 0o700 });
  if (existsSync(machinePath())) {
    try {
      const existing = JSON.parse(readFileSync(machinePath(), "utf8")) as MachineIdentity;
      if (existing.machineId) return existing;
    } catch {
      // Invalid local identity is replaced below.
    }
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
