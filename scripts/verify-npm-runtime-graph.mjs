import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const cliManifest = readManifest(resolve("packages", "cli", "package.json"));
const releaseRoot = resolve(".release", "npm");
const platformManifests = readdirSync(releaseRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => readManifest(resolve(releaseRoot, entry.name, "package.json")));
const expectedPlatforms = Object.entries(cliManifest.optionalDependencies ?? {})
  .sort(([left], [right]) => left.localeCompare(right));
const actualPlatforms = platformManifests
  .map((manifest) => [manifest.name, manifest.version])
  .sort(([left], [right]) => left.localeCompare(right));

assertEmptyRuntimeMap(cliManifest, "dependencies");
assertExactEntries(actualPlatforms, expectedPlatforms, "platform package set");

for (const manifest of platformManifests) {
  if (manifest.version !== cliManifest.version) {
    fail(`${manifest.name} version ${manifest.version} does not match CLI ${cliManifest.version}`);
  }
  assertEmptyRuntimeMap(manifest, "dependencies");
  assertEmptyRuntimeMap(manifest, "optionalDependencies");
  assertEmptyRuntimeMap(manifest, "peerDependencies");
}

console.log(`Verified ${cliManifest.name}@${cliManifest.version}: four first-party optional platform packages, zero third-party runtime dependencies.`);

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assertEmptyRuntimeMap(manifest, field) {
  const entries = Object.entries(manifest[field] ?? {});
  if (entries.length > 0) {
    fail(`${manifest.name} has unexpected ${field}: ${JSON.stringify(Object.fromEntries(entries))}`);
  }
}

function assertExactEntries(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
