#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const platformKey = `${process.platform}-${process.arch}`;

const packageMap = {
  "darwin-arm64": {
    name: "@skastr0/quasar-cli-darwin-arm64",
    binary: "quasar",
  },
  "darwin-x64": {
    name: "@skastr0/quasar-cli-darwin-x64",
    binary: "quasar",
  },
  "linux-arm64": {
    name: "@skastr0/quasar-cli-linux-arm64",
    binary: "quasar",
  },
  "linux-x64": {
    name: "@skastr0/quasar-cli-linux-x64",
    binary: "quasar",
  },
};

const platformPackage = packageMap[platformKey];

if (platformPackage === undefined) {
  console.error(`Unsupported platform: ${platformKey}`);
  process.exit(1);
}

let binaryPath;
try {
  const packageJsonPath = require.resolve(`${platformPackage.name}/package.json`);
  binaryPath = join(dirname(packageJsonPath), "bin", platformPackage.binary);
} catch {
  console.error(
    `Missing ${platformPackage.name}. Reinstall @skastr0/quasar-cli for ${platformKey}.`,
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
