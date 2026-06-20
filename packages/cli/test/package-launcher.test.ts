import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

const packageRoot = join(import.meta.dir, "..");

const platformPackageName = (): string | undefined => {
  const key = `${process.platform}-${process.arch}`;
  const packages: Record<string, string> = {
    "darwin-arm64": "@skastr0/quasar-cli-darwin-arm64",
    "darwin-x64": "@skastr0/quasar-cli-darwin-x64",
    "linux-arm64": "@skastr0/quasar-cli-linux-arm64",
    "linux-x64": "@skastr0/quasar-cli-linux-x64",
  };
  return packages[key];
};

const createInstalledCli = (options: { readonly includePlatformPackage: boolean }) => {
  const root = mkdtempSync(join(tmpdir(), "quasar-cli-package-"));
  const cliBin = join(root, "node_modules", "@skastr0", "quasar-cli", "bin", "quasar.js");
  const exposedBin = join(root, "node_modules", ".bin", "quasar");

  mkdirSync(dirname(cliBin), { recursive: true });
  mkdirSync(dirname(exposedBin), { recursive: true });
  copyFileSync(join(packageRoot, "bin", "quasar.js"), cliBin);
  chmodSync(cliBin, 0o755);
  symlinkSync("../@skastr0/quasar-cli/bin/quasar.js", exposedBin);

  const platformName = platformPackageName();
  if (platformName !== undefined && options.includePlatformPackage) {
    const platformRoot = join(root, "node_modules", ...platformName.split("/"));
    const platformBin = join(platformRoot, "bin", "quasar");
    mkdirSync(dirname(platformBin), { recursive: true });
    writeFileSync(
      join(platformRoot, "package.json"),
      JSON.stringify({ name: platformName, version: "0.0.0", files: ["bin"] }),
    );
    writeFileSync(
      platformBin,
      [
        "#!/usr/bin/env node",
        "console.log(JSON.stringify({ argv: process.argv.slice(2), binary: process.argv[1] }));",
      ].join("\n"),
    );
    chmodSync(platformBin, 0o755);
  }

  return { root, exposedBin, platformName };
};

const runInstalledCli = async (path: string, args: readonly string[]) => {
  const proc = Bun.spawn([path, ...args], {
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stderr, stdout };
};

describe("package launcher", () => {
  const platformName = platformPackageName();
  const packageTest = platformName === undefined ? test.skip : test;

  packageTest("node_modules .bin launcher executes the installed platform package binary", async () => {
    const install = createInstalledCli({ includePlatformPackage: true });
    const result = await runInstalledCli(install.exposedBin, ["stats", "--json"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      argv: ["stats", "--json"],
      binary: realpathSync(join(install.root, "node_modules", ...install.platformName!.split("/"), "bin", "quasar")),
    });
  });

  packageTest("node_modules .bin launcher fails clearly when the platform package is missing", async () => {
    const install = createInstalledCli({ includePlatformPackage: false });
    const result = await runInstalledCli(install.exposedBin, ["help"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`Missing ${install.platformName}.`);
  });
});
