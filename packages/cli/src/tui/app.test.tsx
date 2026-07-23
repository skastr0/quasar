import { expect, test } from "bun:test";
import { act } from "react";

import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";

import { App } from "./app";
import type {
  MessageRow,
  Outcome,
  QuasarClientLike,
  SearchMatch,
  SearchMode,
  ToolCallRow,
} from "./quasar-client";

// In-process headless tests via opentui's official test renderer — no PTY, no
// subprocess, no ANSI parsing. The data layer is injected as a fixture client,
// so tests never touch curl/the server. Pattern from prism's plugins-tui tests.
//
// GOTCHA (learned the hard way): mockInput.pressKey("tab") sends the literal
// chars t-a-b. Use the dedicated pressTab()/pressEnter()/pressArrow()/pressEscape().
// Single-char commands (m/t/j/k/q/?) are fine via pressKey.

const match = (i: number, over: Partial<SearchMatch> = {}): SearchMatch => ({
  key: `kimi:s${i}:1:reasoning`,
  score: 14 - i,
  sessionId: `kimi:s${i}`,
  seq: 1,
  role: "reasoning",
  projectKey: "git:github.com/skastr0/quasar",
  provider: "kimi",
  text: "The code should create vector index if includeVector is not false.",
  ...over,
});

const fakeClient = (opts: {
  matches?: readonly SearchMatch[];
  messages?: readonly MessageRow[];
  tools?: readonly ToolCallRow[];
  toolDetail?: ToolCallRow;
  toolCallImpl?: (id: string) => Promise<Outcome<ToolCallRow>>;
  searchImpl?: (q: string, mode: SearchMode) => Promise<Outcome<readonly SearchMatch[]>>;
}): QuasarClientLike => ({
  search: opts.searchImpl ?? (async () => ({ ok: true, value: opts.matches ?? [] })),
  messages: async () => ({ ok: true, value: opts.messages ?? [] }),
  toolCalls: async () => ({ ok: true, value: opts.tools ?? [] }),
  toolCall: opts.toolCallImpl ?? (async (id) => {
    const row = opts.toolDetail ?? opts.tools?.find((tool) => tool.id === id);
    return row === undefined
      ? { ok: false, code: "NotFound", message: `missing ${id}` }
      : { ok: true, value: row };
  }),
});

const render = (client: QuasarClientLike | null) =>
  testRender(<App options={{}} onExit={() => {}} client={client} />, { width: 120, height: 40 });

// Advance real time so the 200ms search debounce + async client + re-render settle.
const settle = (setup: TestRendererSetup, ms = 350) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

test("renders a configuration error when no server is configured", async () => {
  const setup = await render(null);
  try {
    await settle(setup, 60);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("no server configured");
    expect(frame).toContain("quasar");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("typing a query renders ranked results with provenance", async () => {
  const setup = await render(fakeClient({ matches: [match(0), match(1, { provider: "grok" })] }));
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector index");
    });
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("2 matches");
    expect(frame).toContain("kimi");
    expect(frame).toContain("grok");
    expect(frame).toContain("create vector index");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("Enter opens the session transcript reader", async () => {
  const setup = await render(
    fakeClient({
      matches: [match(0)],
      messages: [
        { seq: 0, role: "user", text: "explore the quasar repo", ts: null },
        { seq: 1, role: "assistant", text: "found the vector index path", ts: null },
      ],
    }),
  );
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup);
    act(() => setup.mockInput.pressTab()); // search -> list focus
    act(() => setup.mockInput.pressEnter()); // open reader
    await settle(setup, 150);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("transcript");
    expect(frame).toContain("explore the quasar repo");
    expect(frame).toContain("[0] user");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("t opens tool-call forensics for the selected session", async () => {
  const setup = await render(
    fakeClient({
      matches: [match(0)],
      tools: [
        {
          id: "t1",
          sessionId: "kimi:s0",
          seq: 0,
          toolName: "Glob",
          status: "completed",
          inputText: "{}",
          outputText: "ok",
          inputBytes: 2,
          outputBytes: 2,
          provider: "kimi",
          projectKey: "git:github.com/skastr0/quasar",
        },
      ],
    }),
  );
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup);
    act(() => setup.mockInput.pressTab()); // list focus
    act(() => setup.mockInput.pressKey("t")); // tool forensics
    await settle(setup, 150);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("tool calls");
    expect(frame).toContain("Glob");
    expect(frame).toContain("completed");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("tool payloads load only after drilling into a body-free summary", async () => {
  let detailCalls = 0;
  const summary: ToolCallRow = {
    id: "t-lazy",
    sessionId: "kimi:s0",
    seq: 4,
    toolName: "exec_command",
    status: "completed",
    inputText: "",
    outputText: "",
    inputBytes: 13,
    outputBytes: 17,
    provider: "kimi",
    projectKey: "git:github.com/skastr0/quasar",
  };
  const detail: ToolCallRow = {
    ...summary,
    inputText: '{"cmd":"pwd"}',
    outputText: "lazy detail body",
  };
  const setup = await render(fakeClient({
    matches: [match(0)],
    tools: [summary],
    toolCallImpl: async () => {
      detailCalls += 1;
      return { ok: true, value: detail };
    },
  }));
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup);
    act(() => setup.mockInput.pressTab());
    act(() => setup.mockInput.pressKey("t"));
    await settle(setup, 150);
    expect(detailCalls).toBe(0);
    expect(setup.captureCharFrame()).not.toContain("lazy detail body");

    act(() => setup.mockInput.pressKey("i"));
    await settle(setup, 150);
    expect(detailCalls).toBe(1);
    expect(setup.captureCharFrame()).toContain("lazy detail body");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("cycling to a not-ready mode silently falls back to lexical with ~", async () => {
  const searchImpl = async (_q: string, mode: SearchMode): Promise<Outcome<readonly SearchMatch[]>> =>
    mode === "lexical"
      ? { ok: true, value: [match(0)] }
      : { ok: false, code: "SearchIndexNotReady", message: "reconciling" };
  const setup = await render(fakeClient({ searchImpl }));
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup); // lexical results present
    act(() => setup.mockInput.pressTab()); // list focus
    act(() => setup.mockInput.pressKey("m")); // lexical -> semantic (not ready) -> fallback lexical + ~
    await settle(setup);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("~"); // fell-back indicator
    expect(frame).toContain("kimi"); // still shows lexical results
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("transcript load rejection surfaces in the header error strip", async () => {
  const client: QuasarClientLike = {
    search: async () => ({ ok: true, value: [match(0)] }),
    messages: async () => {
      throw new Error("session fetch exploded");
    },
    toolCalls: async () => ({ ok: true, value: [] }),
    toolCall: async () => ({ ok: false, code: "NotFound", message: "missing" }),
  };
  const setup = await render(client);
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup);
    act(() => setup.mockInput.pressTab());
    act(() => setup.mockInput.pressEnter());
    await settle(setup, 150);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("session fetch exploded");
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("failed messages for editor path surfaces error and does not exit to editor", async () => {
  // writeTempFile + onExit({editorFile}) are the success path; both only run
  // after a successful messages load. Non-ok must surface and stay in the TUI.
  let exitCalls = 0;
  let editorExits = 0;
  let messagesCalls = 0;
  const client: QuasarClientLike = {
    search: async () => ({ ok: true, value: [match(0)] }),
    messages: async () => {
      messagesCalls += 1;
      return { ok: false, code: "Network", message: "network down" };
    },
    toolCalls: async () => ({ ok: true, value: [] }),
    toolCall: async () => ({ ok: false, code: "NotFound", message: "missing" }),
  };
  const setup = await testRender(
    <App
      options={{}}
      onExit={(exit) => {
        exitCalls += 1;
        if (exit?.editorFile !== undefined) editorExits += 1;
      }}
      client={client}
    />,
    { width: 120, height: 40 },
  );
  try {
    await act(async () => {
      await setup.mockInput.typeText("vector");
    });
    await settle(setup);
    act(() => setup.mockInput.pressTab()); // list focus
    act(() => setup.mockInput.pressKey("e")); // openEditor → messages reload
    await settle(setup, 200);
    const frame = setup.captureCharFrame();
    expect(frame).toContain("network down");
    expect(messagesCalls).toBeGreaterThan(0);
    expect(exitCalls).toBe(0);
    expect(editorExits).toBe(0);
  } finally {
    act(() => setup.renderer.destroy());
  }
});
