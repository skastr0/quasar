import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function quasarStateRoot() {
  return resolve(process.env.QUASAR_CONTROL_HOME ?? join(homedir(), ".quasar-control"));
}

export function quasarConvexLocalRoot() {
  return resolve(
    process.env.QUASAR_CONVEX_LOCAL_ROOT ??
      join(quasarStateRoot(), "local", "default"),
  );
}

export function quasarConvexBackupRoot() {
  return resolve(
    process.env.QUASAR_BACKUP_ROOT ??
      join(quasarStateRoot(), "backups", "convex"),
  );
}
