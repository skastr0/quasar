/**
 * verify:live driver — runs every live battery against the pinned self-hosted
 * backend and aggregates exit codes, so one red battery never hides another's
 * report. Batteries: (a) reconcile, (d) relevance, (e) fidelity.
 */
const BATTERIES = [
  "scripts/verify/reconcile.ts",
  "scripts/verify/relevance.ts",
  "scripts/verify/fidelity.ts",
];

let failed = 0;
for (const battery of BATTERIES) {
  console.log(`\n=== ${battery} ===`);
  const result = Bun.spawnSync(["bun", battery], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) failed += 1;
}
console.log();
if (failed > 0) {
  console.log(`verify:live: ${failed} batter${failed === 1 ? "y" : "ies"} red.`);
  process.exit(1);
}
console.log("verify:live: all live batteries green.");
