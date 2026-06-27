/**
 * Route-out actions: the TUI finds, Unix tools manipulate. Clipboard yank and a
 * temp-file + $EDITOR handoff (we leave the TUI and drop the user into their
 * editor — "find and route, then get out of the way").
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MessageRow } from "./quasar-client";

const CLIPBOARD_TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["pbcopy", []],
  ["wl-copy", []],
  ["xclip", ["-selection", "clipboard"]],
  ["xsel", ["--clipboard", "--input"]],
];

let cachedTool: readonly [string, readonly string[]] | null = null;

const tryCopy = (tool: readonly [string, readonly string[]], text: string): boolean => {
  try {
    return spawnSync(tool[0], [...tool[1]], { input: text }).status === 0;
  } catch {
    return false;
  }
};

export const copyToClipboard = (text: string): boolean => {
  if (cachedTool && tryCopy(cachedTool, text)) return true;
  for (const tool of CLIPBOARD_TOOLS) {
    if (tryCopy(tool, text)) {
      cachedTool = tool;
      return true;
    }
  }
  return false;
};

export const editorCommand = (): string => process.env.VISUAL ?? process.env.EDITOR ?? "vi";

export const transcriptToText = (sessionId: string, messages: readonly MessageRow[]): string => {
  const head = `# quasar session ${sessionId}\n`;
  const body = messages
    .map((m) => `\n## [${m.seq}] ${m.role}${m.ts ? `  ${m.ts}` : ""}\n\n${m.text}`)
    .join("\n");
  return `${head}${body}\n`;
};

/** Write content to a reused temp dir (one file per session slug — bounded, no per-call leak). */
export const writeTempFile = (slug: string, content: string): string => {
  const dir = join(tmpdir(), "quasar-tui");
  mkdirSync(dir, { recursive: true });
  const safe = slug.replace(/[^\w.-]+/g, "_").slice(0, 60) || "session";
  const file = join(dir, `${safe}.md`);
  writeFileSync(file, content);
  return file;
};
