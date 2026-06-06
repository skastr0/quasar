import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const releaseRoot = resolve(".release", "npm");
const packageDirs = [
  ...readdirSync(releaseRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(releaseRoot, entry.name)),
  resolve("packages", "cli"),
];

for (const packageDir of packageDirs) {
  run("npm", ["pack", "--dry-run", packageDir]);
}

function run(command, args) {
  console.log(`> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
