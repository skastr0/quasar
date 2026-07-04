#!/usr/bin/env bun
// Ensures a dlopen-able simsimd shared library exists for this platform.
//
// The pinned simsimd npm package ships linux-arm64/linux-x64 prebuilds
// (compiled with SIMSIMD_DYNAMIC_DISPATCH=1, so the .node file exports the
// plain C ABI simsimd_cos_f16 etc. that packages/server dlopens via bun:ffi).
// On darwin there is no prebuild, so this script compiles the exact same
// pinned package sources once into packages/server/.native/. The artifact
// name embeds the package version: bumping simsimd invalidates it naturally.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

const prebuild = resolve(packageRoot, `prebuilds/${platform}-${arch}/simsimd.node`);
if (existsSync(prebuild)) {
  console.log(JSON.stringify({ ok: true, script: "ensure-simsimd-native", version, library: prebuild, source: "prebuild" }));
  process.exit(0);
}

if (platform !== "darwin") {
  fail(`no simsimd prebuild for ${platform}-${arch} and no local build recipe for this platform`);
}

const artifact = resolve(nativeDir, `libsimsimd-v${version}-${platform}-${arch}.dylib`);
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
  fail(`cc failed with status ${compile.status}; a C compiler (Xcode CLT) is required once on darwin`);
}
console.log(JSON.stringify({ ok: true, script: "ensure-simsimd-native", version, library: artifact, source: "fresh-build" }));
