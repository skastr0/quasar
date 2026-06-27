import { expect, test } from "bun:test";

import { type Focus, type Key, type KeyContext, routeKey } from "./keymap";

const ctx = (focus: Focus, over: Partial<KeyContext> = {}): KeyContext => ({
  focus,
  hasResults: true,
  queryEmpty: false,
  helpOpen: false,
  ...over,
});

const key = (name: string, over: Partial<Key> = {}): Key => ({ name, sequence: name, ...over });

test("search: printable types, space types a space", () => {
  expect(routeKey(key("a"), ctx("search"))).toEqual({ t: "type", ch: "a" });
  expect(routeKey(key("space"), ctx("search"))).toEqual({ t: "type", ch: " " });
});

test("search: arrows and ctrl-n/p move the selection without leaving the omnibox", () => {
  expect(routeKey(key("down"), ctx("search"))).toEqual({ t: "move", delta: 1 });
  expect(routeKey(key("up"), ctx("search"))).toEqual({ t: "move", delta: -1 });
  expect(routeKey(key("n", { ctrl: true }), ctx("search"))).toEqual({ t: "move", delta: 1 });
  expect(routeKey(key("p", { ctrl: true }), ctx("search"))).toEqual({ t: "move", delta: -1 });
});

test("search: tab drops to list, enter dives into reader when there are results", () => {
  expect(routeKey(key("tab"), ctx("search"))).toEqual({ t: "focusList" });
  expect(routeKey(key("return"), ctx("search"))).toEqual({ t: "openReader" });
  expect(routeKey(key("return"), ctx("search", { hasResults: false }))).toEqual({ t: "none" });
});

test("search: escape clears the query, or quits when already empty", () => {
  expect(routeKey(key("escape"), ctx("search"))).toEqual({ t: "clearQuery" });
  expect(routeKey(key("escape"), ctx("search", { queryEmpty: true }))).toEqual({ t: "quit" });
});

test("list: vim navigation and jump", () => {
  expect(routeKey(key("j"), ctx("list"))).toEqual({ t: "move", delta: 1 });
  expect(routeKey(key("k"), ctx("list"))).toEqual({ t: "move", delta: -1 });
  expect(routeKey(key("G"), ctx("list"))).toEqual({ t: "last" });
  expect(routeKey(key("g"), ctx("list"))).toEqual({ t: "first" });
  expect(routeKey(key("3"), ctx("list"))).toEqual({ t: "jump", index: 2 });
});

test("list: commands map to intents", () => {
  expect(routeKey(key("return"), ctx("list"))).toEqual({ t: "openReader" });
  expect(routeKey(key("s"), ctx("list"))).toEqual({ t: "openReader" });
  expect(routeKey(key("t"), ctx("list"))).toEqual({ t: "toggleTools" });
  expect(routeKey(key("m"), ctx("list"))).toEqual({ t: "cycleMode" });
  expect(routeKey(key("e"), ctx("list"))).toEqual({ t: "openEditor" });
  expect(routeKey(key("y"), ctx("list"))).toEqual({ t: "yankKey" });
  expect(routeKey(key("y", { shift: true }), ctx("list"))).toEqual({ t: "yankText" });
  expect(routeKey(key("/"), ctx("list"))).toEqual({ t: "focusSearch" });
  expect(routeKey(key("?"), ctx("list"))).toEqual({ t: "toggleHelp" });
  expect(routeKey(key("escape"), ctx("list"))).toEqual({ t: "focusSearch" });
  expect(routeKey(key("q"), ctx("list"))).toEqual({ t: "quit" });
});

test("list: typing letters that aren't commands is a no-op (no accidental search)", () => {
  expect(routeKey(key("z"), ctx("list"))).toEqual({ t: "none" });
});

test("reader: scroll, match hop, tools, and back", () => {
  expect(routeKey(key("j"), ctx("reader"))).toEqual({ t: "scroll", delta: 1 });
  expect(routeKey(key("space"), ctx("reader"))).toEqual({ t: "scroll", delta: 12 });
  expect(routeKey(key("n"), ctx("reader"))).toEqual({ t: "matchNext" });
  expect(routeKey(key("["), ctx("reader"))).toEqual({ t: "matchPrev" });
  expect(routeKey(key("t"), ctx("reader"))).toEqual({ t: "toggleTools" });
  expect(routeKey(key("escape"), ctx("reader"))).toEqual({ t: "back" });
});

test("help overlay traps keys until dismissed", () => {
  expect(routeKey(key("j"), ctx("list", { helpOpen: true }))).toEqual({ t: "none" });
  expect(routeKey(key("?"), ctx("list", { helpOpen: true }))).toEqual({ t: "toggleHelp" });
  expect(routeKey(key("escape"), ctx("list", { helpOpen: true }))).toEqual({ t: "toggleHelp" });
});
