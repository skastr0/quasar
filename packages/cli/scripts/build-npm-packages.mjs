import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, copyFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const repoRoot = resolve(packageDir, "..", "..");
const productionCliEntrypoint = resolve(repoRoot, "packages", "local-server", "src", "cli.ts");
const releaseRoot = resolve(repoRoot, ".release", "npm");
const cliPackage = JSON.parse(
  readFileSync(resolve(packageDir, "package.json"), "utf8"),
);

const targets = [
  {
    platform: "darwin-arm64",
    target: "bun-darwin-arm64",
    os: ["darwin"],
    cpu: ["arm64"],
  },
  {
    platform: "darwin-x64",
    target: "bun-darwin-x64",
    os: ["darwin"],
    cpu: ["x64"],
  },
  {
    platform: "linux-arm64",
    target: "bun-linux-arm64",
    os: ["linux"],
    cpu: ["arm64"],
  },
  {
    platform: "linux-x64",
    target: "bun-linux-x64",
    os: ["linux"],
    cpu: ["x64"],
  },
];

rmSync(releaseRoot, { recursive: true, force: true });
mkdirSync(releaseRoot, { recursive: true });

for (const item of targets) {
  const packageName = `${cliPackage.name}-${item.platform}`;
  const packagePath = resolve(releaseRoot, packageName.replace("/", "__"));
  const binPath = resolve(packagePath, "bin", "quasar");

  mkdirSync(resolve(packagePath, "bin"), { recursive: true });

  run("bun", [
    "build",
    "--compile",
    `--target=${item.target}`,
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

console.log(`Prepared npm platform packages under ${releaseRoot}`);

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
  if (result.status !== 0) process.exit(result.status ?? 1);
}
