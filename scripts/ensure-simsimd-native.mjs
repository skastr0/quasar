#!/usr/bin/env bun
// Ensures a dlopen-able simsimd shared library exists for this platform.
//
// The pinned simsimd npm package ships "prebuilds", but simsimd 6.5.5's
// linux-arm64 prebuild is actually an x86_64 binary (verified 2026-07-04:
// ELF e_machine 0x3e in both prebuild folders of the upstream tarball), so
// prebuilds are only trusted after an architecture check. Wherever no usable
// prebuild exists (darwin always; linux-arm64 today), this compiles the exact
// pinned package sources once into packages/server/.native/. The artifact
// name embeds the package version: bumping simsimd invalidates it naturally.
//
// packages/server/src/vectorKernel.ts resolves the same candidates in the
// same order and self-checks the library against the JS reference before
// trusting it, so a bad artifact can never serve silently.
import { existsSync, mkdirSync, openSync, readSync, closeSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");
const packageRoot = resolve(repoRoot, "packages/server/node_modules/simsimd");
const nativeDir = resolve(repoRoot, "packages/server/.native");

const fail = (message) => {
  console.error(JSON.stringify({ ok: false, script: "ensure-simsimd-native", error: message }));
  process.exit(1);
};

if (!existsSync(packageRoot)) {
  fail(`simsimd package not found at ${packageRoot}; run bun install first`);
}

const version = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8")).version;
const platform = process.platform;
const arch = process.arch;

/** ELF e_machine (or Mach-O cputype) matches the running architecture. */
const machineMatchesArch = (path) => {
  const header = Buffer.alloc(20);
  const fd = openSync(path, "r");
  try {
    readSync(fd, header, 0, 20, 0);
  } finally {
    closeSync(fd);
  }
  if (header.readUInt32BE(0) === 0x7f454c46) {
    const machine = header.readUInt16LE(18);
    return (arch === "arm64" && machine === 0xb7) || (arch === "x64" && machine === 0x3e);
  }
  return false;
};

const prebuild = resolve(packageRoot, `prebuilds/${platform}-${arch}/simsimd.node`);
if (existsSync(prebuild) && platform === "linux" && machineMatchesArch(prebuild)) {
  console.log(JSON.stringify({ ok: true, script: "ensure-simsimd-native", version, library: prebuild, source: "prebuild" }));
  process.exit(0);
}

const extension = platform === "darwin" ? "dylib" : "so";
const artifact = resolve(nativeDir, `libsimsimd-v${version}-${platform}-${arch}.${extension}`);
if (existsSync(artifact)) {
  console.log(JSON.stringify({ ok: true, script: "ensure-simsimd-native", version, library: artifact, source: "cached-build" }));
  process.exit(0);
}

mkdirSync(nativeDir, { recursive: true });
// Same defines the npm prebuilds are built with (see simsimd binding.gyp).
const compile = spawnSync(
  "cc",
  [
    "-O3",
    "-std=c11",
    "-ffast-math",
    "-Wno-unknown-pragmas",
    "-shared",
    "-fPIC",
    "-DSIMSIMD_DYNAMIC_DISPATCH=1",
    "-DSIMSIMD_NATIVE_F16=0",
    "-DSIMSIMD_NATIVE_BF16=0",
    `-I${resolve(packageRoot, "include")}`,
    resolve(packageRoot, "c/lib.c"),
    "-o",
    artifact,
  ],
  { stdio: ["ignore", "inherit", "inherit"] },
);
if (compile.status !== 0) {
  fail(`cc failed with status ${compile.status}; a C compiler is required once on this platform (Xcode CLT on darwin, gcc on linux)`);
}
console.log(JSON.stringify({ ok: true, script: "ensure-simsimd-native", version, library: artifact, source: "fresh-build" }));
