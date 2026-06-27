/**
 * Quasar TUI palette — warm near-black with a single amber accent, inherited
 * from the sibling `rig` aesthetic so the tools feel like one ecosystem.
 * Differentiation is by foreground color only (no bold/italic chrome).
 */
export const palette = {
  bg: "#11100d", // warm near-black background
  panel: "#171510", // panel fill
  panelRaised: "#1d1a14", // raised surface (keybar, footer)
  border: "#3a3327", // barely-visible warm-gray border
  borderActive: "#6a5f47", // focused pane border
  text: "#e8dfcf", // warm off-white primary text
  muted: "#8d8576", // de-emphasized labels
  amber: "#d6a94a", // accent / active / selection
  cyan: "#6dc7d1", // provenance / harness label
  violet: "#9a7bdc", // secondary accent
  green: "#8fb573", // success / ready
  crimson: "#d65f5f", // error / not-ready
} as const;

export type Palette = typeof palette;
