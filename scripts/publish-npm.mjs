import { readdirSync, readFileSync } from "node:fs";
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
  const packageJson = JSON.parse(
    readFileSync(resolve(packageDir, "package.json"), "utf8"),
  );
  const packageId = `${packageJson.name}@${packageJson.version}`;

  if (npmVersionExists(packageId)) {
    console.log(`Skipping ${packageId}; already published.`);
    continue;
  }

  console.log(`Publishing ${packageId} from ${packageDir}`);
  run("npm", ["publish", packageDir, "--access", "public"]);
}

function npmVersionExists(packageId) {
  const result = spawnSync(
    "npm",
    ["view", packageId, "version", "--prefer-online"],
    {
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
