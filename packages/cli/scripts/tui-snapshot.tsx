/**
 * Headless "screenshots" of the Quasar TUI — drives the real component in
 * opentui's in-process test renderer and prints each state's character frame.
 * No PTY, no real terminal. Replaces ad-hoc PTY drivers. Uses the real client
 * (resolved from your quasar config), so frames show real session data.
 *
 *   bun packages/cli/scripts/tui-snapshot.tsx "effect timeout" [width] [height]
 *
 * GOTCHA: use the dedicated mockInput.pressTab()/pressEnter() — pressKey("tab")
 * would send the literal characters t-a-b.
 */
import { act } from "react";

import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/tui/app";

const query = process.argv[2] ?? "vector index";
const width = Number(process.argv[3] ?? 130);
const height = Number(process.argv[4] ?? 40);
const latencyMs = Number(process.env.QUASAR_TUI_SNAPSHOT_SETTLE ?? 3000);

const setup: TestRendererSetup = await testRender(<App options={{}} onExit={() => {}} />, { width, height });

const settle = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const snap = (label: string) => {
  process.stdout.write(`\n===== ${label} =====\n${setup.captureCharFrame()}\n`);
};

await settle(300);
await act(async () => {
  await setup.mockInput.typeText(query);
});
await settle(latencyMs);
snap(`SEARCH "${query}"`);

// await act — script is sequential; unawaited act() is a floating promise (TS-CC-01).
await act(() => {
  setup.mockInput.pressTab(); // search -> list focus
});
await act(() => {
  setup.mockInput.pressEnter(); // open the session transcript reader
});
await settle(latencyMs);
snap("READER  session transcript");

await act(() => {
  setup.mockInput.pressKey("t"); // tool-call forensics
});
await settle(latencyMs);
snap("READER  tool-call forensics");

await act(() => {
  setup.renderer.destroy();
});
process.exit(0);
