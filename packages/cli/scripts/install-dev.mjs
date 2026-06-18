#!/usr/bin/env bun

import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join, resolve } from "node:path";

const INSTALL_DIR = process.env.INSTALL_DIR || join(homedir(), ".local", "bin");
const DEV_BINARY_NAME = process.env.QUASAR_DEV_BIN || "quasar-dev";
const PRODUCTION_BINARY_NAME = "quasar";

/**
 * Detect the current platform-arch string (e.g. "darwin-arm64").
 * Exits with an error on unsupported platforms.
 */
function detectPlatform() {
  const os = platform();
  const cpu = arch();

  let platformStr;
  switch (os) {
    case "darwin":
      platformStr = "darwin";
      break;
    case "linux":
      platformStr = "linux";
      break;
    default:
      console.error(`Unsupported operating system: ${os}`);
      process.exit(1);
  }

  let archStr;
  switch (cpu) {
    case "x64":
      archStr = "x64";
      break;
    case "arm64":
      archStr = "arm64";
      break;
    default:
      console.error(`Unsupported architecture: ${cpu}`);
      process.exit(1);
  }

  return `${platformStr}-${archStr}`;
}

const packageDir = resolve(import.meta.dir, "..");
const distBinaryPath = resolve(packageDir, "dist", "quasar");

const resolveSymlinkTarget = (linkPath) => {
  try {
    return lstatSync(linkPath).isSymbolicLink() ? resolve(readlinkSync(linkPath)) : undefined;
  } catch {
    return undefined;
  }
};

const isLegacyDevQuasarInstall = (linkPath, distBinary) => {
  const target = resolveSymlinkTarget(linkPath);
  return target === distBinary;
};

async function install() {
  const platformArch = detectPlatform();
  console.log(`Detected platform: ${platformArch}`);

  if (!existsSync(distBinaryPath)) {
    console.error(`Dev binary not found at ${distBinaryPath}`);
    console.error(`Run 'bun run --cwd packages/cli build' first to compile the dev binary.`);
    process.exit(1);
  }

  mkdirSync(INSTALL_DIR, { recursive: true });

  // Never touch the production quasar — leave it on mise/npm.
  const productionPath = join(INSTALL_DIR, PRODUCTION_BINARY_NAME);
  if (existsSync(productionPath)) {
    if (isLegacyDevQuasarInstall(productionPath, distBinaryPath)) {
      console.log(`Removing legacy dev-symlink at production path: ${productionPath}`);
      rmSync(productionPath);
    } else {
      console.log(`Leaving production binary untouched: ${productionPath}`);
    }
  }

  const destPath = join(INSTALL_DIR, DEV_BINARY_NAME);

  if (existsSync(destPath)) {
    rmSync(destPath);
  }

  // Sign the dist binary on macOS so the dev symlink stays executable.
  if (platform() === "darwin") {
    try {
      await Bun.$`codesign --sign - --force ${distBinaryPath}`;
    } catch {
      // Non-fatal: codesign may be unavailable in CI or sandboxed envs.
    }
  }

  console.log(`Linking ${destPath} -> ${distBinaryPath}...`);
  await Bun.$`ln -s ${distBinaryPath} ${destPath}`;

  console.log(`\n✓ Installed ${DEV_BINARY_NAME} to ${destPath}`);
  console.log(`  Production quasar stays on mise/npm: ${PRODUCTION_BINARY_NAME}`);
  console.log(`  Rebuild with 'bun run --cwd packages/cli build' — ${DEV_BINARY_NAME} picks up dist/ automatically.`);

  const pathDirs = (process.env.PATH || "").split(":");
  if (!pathDirs.includes(INSTALL_DIR)) {
    console.log(`\n⚠  ${INSTALL_DIR} is not on your PATH.`);
    console.log(`   Add it to your shell profile, or run:`);
    console.log(`   export PATH="${INSTALL_DIR}:$PATH"`);
  }

  console.log(`\nRun '${DEV_BINARY_NAME} --help' to try the dev build.`);
}

install();