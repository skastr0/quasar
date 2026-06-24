import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

const packages = [
  "packages/cli",
  ".release/npm/@skastr0__quasar-cli-darwin-arm64",
  ".release/npm/@skastr0__quasar-cli-darwin-x64",
  ".release/npm/@skastr0__quasar-cli-linux-arm64",
  ".release/npm/@skastr0__quasar-cli-linux-x64",
];

for (const packagePath of packages) {
  const absolutePath = resolve(root, packagePath);
  if (!existsSync(absolutePath)) {
    console.error(`missing package artifact: ${packagePath}`);
    process.exit(1);
  }

  const result = spawnSync("bun", ["x", "publint", absolutePath], {
    cwd: root,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
