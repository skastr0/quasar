/**
 * Pure key dispatch for the TUI. Modeled on rig's testable `handleRigKey`:
 * `routeKey(key, ctx)` maps a keypress to an Intent given the current focus,
 * with zero React/opentui coupling so the whole interaction model is unit-tested.
 *
 * Three focuses, no vim normal/insert/visual modes:
 *  - search :: the omnibox. Typing live-searches; Enter dives into the reader,
 *    Tab drops to the list, Esc clears or quits.
 *  - list   :: the evidence-browser spine. Single-char vim commands.
 *  - reader :: a less-style pager over a transcript or tool-call forensics.
 */

export type Focus = "search" | "list" | "reader";

/** Minimal key shape — a structural subset of opentui's KeyEvent. */
export interface Key {
  readonly name: string;
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly meta?: boolean;
  readonly option?: boolean;
  readonly sequence?: string;
}

export interface KeyContext {
  readonly focus: Focus;
  readonly hasResults: boolean;
  readonly queryEmpty: boolean;
  readonly helpOpen: boolean;
}

export type Intent =
  | { readonly t: "type"; readonly ch: string }
  | { readonly t: "backspace" }
  | { readonly t: "clearQuery" }
  | { readonly t: "deleteWord" }
  | { readonly t: "focusSearch" }
  | { readonly t: "focusList" }
  | { readonly t: "move"; readonly delta: number }
  | { readonly t: "first" }
  | { readonly t: "last" }
  | { readonly t: "jump"; readonly index: number }
  | { readonly t: "openReader" }
  | { readonly t: "toggleTools" }
  | { readonly t: "drill" }
  | { readonly t: "matchNext" }
  | { readonly t: "matchPrev" }
  | { readonly t: "scroll"; readonly delta: number }
  | { readonly t: "cycleMode" }
  | { readonly t: "openEditor" }
  | { readonly t: "yankKey" }
  | { readonly t: "yankText" }
  | { readonly t: "toggleHelp" }
  | { readonly t: "back" }
  | { readonly t: "quit" }
  | { readonly t: "none" };

const NONE: Intent = { t: "none" };

const isPrintable = (key: Key): boolean => {
  if (key.ctrl || key.meta || key.option) return false;
  if (key.name === "space") return true;
  const ch = key.sequence ?? key.name;
  return ch.length === 1 && ch >= " ";
};

const charOf = (key: Key): string => {
  if (key.name === "space") return " ";
  return key.sequence && key.sequence.length === 1 ? key.sequence : key.name;
};

const routeSearch = (key: Key, ctx: KeyContext): Intent => {
  const { name } = key;
  if (key.ctrl && name === "u") return { t: "clearQuery" };
  if (key.ctrl && name === "w") return { t: "deleteWord" };
  if (key.ctrl && (name === "n" || name === "j")) return { t: "move", delta: 1 };
  if (key.ctrl && (name === "p" || name === "k")) return { t: "move", delta: -1 };
  if (name === "down") return { t: "move", delta: 1 };
  if (name === "up") return { t: "move", delta: -1 };
  if (name === "tab") return { t: "focusList" };
  if (name === "return") return ctx.hasResults ? { t: "openReader" } : NONE;
  if (name === "backspace") return ctx.queryEmpty ? NONE : { t: "backspace" };
  if (name === "escape") return ctx.queryEmpty ? { t: "quit" } : { t: "clearQuery" };
  if (isPrintable(key)) return { t: "type", ch: charOf(key) };
  return NONE;
};

const routeList = (key: Key, ctx: KeyContext): Intent => {
  const { name, shift } = key;
  if (key.ctrl && name === "c") return { t: "quit" };
  if (name === "j" || name === "down") return { t: "move", delta: 1 };
  if (name === "k" || name === "up") return { t: "move", delta: -1 };
  if (name === "g" && !shift) return { t: "first" };
  if ((name === "g" && shift) || name === "G") return { t: "last" };
  if (/^[1-9]$/.test(name)) return { t: "jump", index: Number(name) - 1 };
  if (name === "return" || name === "l" || name === "s") return ctx.hasResults ? { t: "openReader" } : NONE;
  if (name === "t") return ctx.hasResults ? { t: "toggleTools" } : NONE;
  if (name === "m") return { t: "cycleMode" };
  if (name === "e") return ctx.hasResults ? { t: "openEditor" } : NONE;
  if (name === "y" && !shift) return ctx.hasResults ? { t: "yankKey" } : NONE;
  if ((name === "y" && shift) || name === "Y") return ctx.hasResults ? { t: "yankText" } : NONE;
  if (name === "/") return { t: "focusSearch" };
  if (name === "?") return { t: "toggleHelp" };
  if (name === "escape") return { t: "focusSearch" };
  if (name === "q") return { t: "quit" };
  return NONE;
};

const routeReader = (key: Key, _ctx: KeyContext): Intent => {
  const { name, shift } = key;
  if (key.ctrl && name === "c") return { t: "quit" };
  if (name === "j" || name === "down") return { t: "scroll", delta: 1 };
  if (name === "k" || name === "up") return { t: "scroll", delta: -1 };
  if (name === "space" || (key.ctrl && name === "d")) return { t: "scroll", delta: 12 };
  if (name === "b" || (key.ctrl && name === "u")) return { t: "scroll", delta: -12 };
  if (name === "g" && !shift) return { t: "first" };
  if ((name === "g" && shift) || name === "G") return { t: "last" };
  if (name === "n" || name === "]") return { t: "matchNext" };
  if (name === "N" || name === "[") return { t: "matchPrev" };
  if (name === "t") return { t: "toggleTools" };
  if (name === "i" || name === "return") return { t: "drill" };
  if (name === "e") return { t: "openEditor" };
  if (name === "y" && !shift) return { t: "yankKey" };
  if ((name === "y" && shift) || name === "Y") return { t: "yankText" };
  if (name === "escape") return { t: "back" };
  if (name === "q") return { t: "quit" };
  return NONE;
};

export const routeKey = (key: Key, ctx: KeyContext): Intent => {
  // Help overlay is a modal trap: any key closes it.
  if (ctx.helpOpen) {
    if (key.name === "escape" || key.name === "q" || key.name === "?") return { t: "toggleHelp" };
    return NONE;
  }
  switch (ctx.focus) {
    case "search":
      return routeSearch(key, ctx);
    case "list":
      return routeList(key, ctx);
    case "reader":
      return routeReader(key, ctx);
  }
};
