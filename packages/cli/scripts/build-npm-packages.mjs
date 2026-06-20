import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "..", "..");
const productionCliEntrypoint = resolve(packageDir, "src", "cli.ts");
const releaseRoot = resolve(repoRoot, ".release", "npm");
const cliPackage = JSON.parse(
  readFileSync(resolve(packageDir, "package.json"), "utf8"),
);

const lancedbNativePackages = [
  "@lancedb/lancedb-darwin-arm64",
  "@lancedb/lancedb-linux-arm64-gnu",
  "@lancedb/lancedb-linux-arm64-musl",
  "@lancedb/lancedb-linux-x64-gnu",
  "@lancedb/lancedb-linux-x64-musl",
  "@lancedb/lancedb-win32-arm64-msvc",
  "@lancedb/lancedb-win32-x64-msvc",
];

const targets = [
  {
    platform: "darwin-arm64",
    target: "bun-darwin-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
    nativePackages: ["@lancedb/lancedb-darwin-arm64"],
  },
  {
    platform: "darwin-x64",
    target: "bun-darwin-x64",
    os: ["darwin"],
    cpu: ["x64"],
    nativePackages: [],
  },
  {
    platform: "linux-arm64",
    target: "bun-linux-arm64",
    os: ["linux"],
    cpu: ["arm64"],
    nativePackages: ["@lancedb/lancedb-linux-arm64-gnu"],
  },
  {
    platform: "linux-x64",
    target: "bun-linux-x64",
    os: ["linux"],
    cpu: ["x64"],
    nativePackages: ["@lancedb/lancedb-linux-x64-gnu"],
  },
];

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

async function main() {
  rmSync(releaseRoot, { recursive: true, force: true });
  mkdirSync(releaseRoot, { recursive: true });

  try {
    for (const item of targets) {
      run("bun", ["install", "--frozen-lockfile", `--os=${item.os[0]}`, `--cpu=${item.cpu[0]}`]);

      const packageName = `${cliPackage.name}-${item.platform}`;
      const packagePath = resolve(releaseRoot, packageName.replace("/", "__"));
      const binPath = resolve(packagePath, "bin", "quasar");

      mkdirSync(resolve(packagePath, "bin"), { recursive: true });

      run("bun", [
        "build",
        "--compile",
        `--target=${item.target}`,
        ...externalNativePackageArgs(item),
        productionCliEntrypoint,
        "--outfile",
        binPath,
      ]);

      await chmod(binPath, 0o755);
      await copyFile(resolve(packageDir, "README.md"), resolve(packagePath, "README.md"));
      await copyFile(resolve(repoRoot, "LICENSE"), resolve(packagePath, "LICENSE"));

      writeFileSync(
        resolve(packagePath, "package.json"),
        `${JSON.stringify(platformPackageJson(packageName, item), null, 2)}\n`,
        "utf8",
      );
    }
  } finally {
    if (process.env.QUASAR_SKIP_HOST_INSTALL_RESTORE !== "1") {
      run("bun", ["install", "--frozen-lockfile"]);
    }
  }

  console.log(`Prepared npm platform packages under ${releaseRoot}`);
}

function externalNativePackageArgs(item) {
  const bundled = new Set(item.nativePackages);
  return lancedbNativePackages
    .filter((packageName) => !bundled.has(packageName))
    .map((packageName) => `--external=${packageName}`);
}

function platformPackageJson(packageName, item) {
  return {
    name: packageName,
    version: cliPackage.version,
    description: `${cliPackage.description} (${item.platform} binary).`,
    license: cliPackage.license,
    type: "module",
    os: item.os,
    cpu: item.cpu,
    repository: cliPackage.repository,
    homepage: cliPackage.homepage,
    bugs: cliPackage.bugs,
    publishConfig: {
      access: "public",
    },
    files: ["bin", "README.md", "LICENSE"],
  };
}

function run(command, args) {
  console.log(`> ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`);
  }
}
