import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const quasarLocalHome = (): string =>
  process.env.QUASAR_LOCAL_HOME?.trim() || join(homedir(), ".config", "quasar", "local-server");

export const sqlitePath = (): string =>
  process.env.QUASAR_LOCAL_SQLITE?.trim() || join(quasarLocalHome(), "quasar.sqlite");

export const ensureParentDir = (path: string): void => {
  mkdirSync(dirname(path), { recursive: true });
};
