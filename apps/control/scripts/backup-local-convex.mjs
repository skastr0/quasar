import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { quasarConvexBackupRoot, quasarConvexLocalRoot } from "./quasar-state.mjs";

const source = quasarConvexLocalRoot();
if (!existsSync(source)) {
  console.error(`Missing local Convex state root: ${source}`);
  process.exit(1);
}

const destination = join(
  quasarConvexBackupRoot(),
  new Date().toISOString().replaceAll(":", "-"),
);
mkdirSync(destination, { recursive: true, mode: 0o700 });
cpSync(source, destination, { recursive: true, force: true });
console.log(`Backed up Quasar local Convex state to ${destination}`);
