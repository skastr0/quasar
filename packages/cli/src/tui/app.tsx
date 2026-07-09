import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";

import { copyToClipboard, editorCommand, transcriptToText, writeTempFile } from "./actions";
import { snippet, truncate, windowSlice } from "./format";
import { highlight } from "./highlight";
import { type Focus, type Intent, type Key, routeKey } from "./keymap";
import { palette } from "./palette";
import {
  type MessageRow,
  type QuasarClientLike,
  type SearchMatch,
  type SearchMode,
  SEARCH_MODES,
  type ToolCallRow,
  QuasarClient,
} from "./quasar-client";
import { filterSummary, parseQuery, shortProject } from "./query";
import type { TuiExit, TuiOptions } from "./entry";

type ReaderKind = "transcript" | "tools" | "toolDetail";
interface Reader {
  readonly kind: ReaderKind;
  readonly sessionId: string;
}

const SEARCH_LIMIT = 80;
const DEBOUNCE_MS = 200;

const nextMode = (mode: SearchMode): SearchMode =>
  SEARCH_MODES[(SEARCH_MODES.indexOf(mode) + 1) % SEARCH_MODES.length]!;

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message.trim() !== "" ? err.message : fallback;

/**
 * Fire-and-forget under an active opentui renderer: in-process `await` starves
 * libuv poll (see quasar-client). Attach rejection routing so floating failures
 * hit the TUI error surface instead of dying silent.
 */
const routeAsync = <T,>(
  promise: Promise<T>,
  onOk: (value: T) => void,
  onFail: (message: string) => void,
  fallback: string,
): void => {
  void promise.then(onOk).catch((err: unknown) => {
    onFail(errorMessage(err, fallback));
  });
};

// ───────────────────────────────────────────────────────────── presentational

const Header = ({
  effectiveMode,
  fellBack,
  count,
  filters,
  error,
  loading,
}: {
  effectiveMode: SearchMode;
  fellBack: boolean;
  count: number;
  filters: string;
  error: string | null;
  loading: boolean;
}) => (
  <box height={1} flexShrink={0} flexDirection="row" backgroundColor={palette.bg} paddingLeft={1} paddingRight={1}>
    <text content="quasar" fg={palette.amber} />
    <text content={`  ${effectiveMode}${fellBack ? " ~" : ""}`} fg={fellBack ? palette.crimson : palette.cyan} />
    {error ? (
      <text content={`  ${error}`} fg={palette.crimson} />
    ) : (
      <text
        content={`  ${count} match${count === 1 ? "" : "es"}${loading ? " ◌" : ""}${filters ? `  ${filters}` : ""}`}
        fg={palette.muted}
      />
    )}
  </box>
);

const Omnibox = ({ query, focused }: { query: string; focused: boolean }) => (
  <box height={1} flexShrink={0} backgroundColor={palette.panel} paddingLeft={1} paddingRight={1}>
    <text
      content={`${focused ? "›" : " "} ${query}${focused ? "█" : ""}`}
      fg={focused ? palette.text : palette.muted}
    />
  </box>
);

const ResultRow = ({
  match,
  qtext,
  selected,
  width,
}: {
  match: SearchMatch;
  qtext: string;
  selected: boolean;
  width: number;
}) => {
  // Each line is truncated to fit the pane exactly — opentui mis-renders styled
  // text that wraps inside a fixed-height box, so we never let it wrap.
  const meta = truncate(
    `${selected ? "▎" : " "}${match.provider} · ${shortProject(match.projectKey)} · ${match.role} · ${match.score.toFixed(1)}`,
    width,
  );
  const snipLine = truncate(`  ${snippet(match.text, qtext, width)}`, width);
  return (
    <box flexDirection="column" flexShrink={0} height={2} width="100%" overflow="hidden">
      <text content={meta} fg={selected ? palette.amber : palette.muted} />
      <text content={highlight(snipLine, qtext, selected ? palette.text : palette.muted)} />
    </box>
  );
};

const ResultList = ({
  results,
  selected,
  query,
  visible,
  innerWidth,
  focused,
  loading,
}: {
  results: readonly SearchMatch[];
  selected: number;
  query: string;
  visible: number;
  innerWidth: number;
  focused: boolean;
  loading: boolean;
}) => {
  const { start, end } = windowSlice(selected, results.length, visible);
  const qtext = parseQuery(query).text;
  const emptyLabel = query.trim() === "" ? "type to search" : loading ? "searching…" : "no matches";
  return (
    <box
      flexDirection="column"
      width="38%"
      flexShrink={0}
      border
      borderColor={focused ? palette.borderActive : palette.border}
      title=" results "
      paddingLeft={1}
      paddingRight={1}
    >
      {results.length === 0 ? (
        <text content={emptyLabel} fg={palette.muted} />
      ) : (
        results.slice(start, end).map((m, i) => (
          <ResultRow key={m.key} match={m} qtext={qtext} selected={start + i === selected} width={innerWidth} />
        ))
      )}
    </box>
  );
};

const Detail = ({
  reader,
  match,
  query,
  transcript,
  tools,
  toolSel,
  toolDetail,
  scrollRef,
  matchRefs,
  focused,
}: {
  reader: Reader | null;
  match: SearchMatch | undefined;
  query: string;
  transcript: readonly MessageRow[];
  tools: readonly ToolCallRow[];
  toolSel: number;
  toolDetail: ToolCallRow | null;
  scrollRef: React.RefObject<ScrollBoxRenderable | null>;
  matchRefs: React.MutableRefObject<Map<number, BoxRenderable>>;
  focused: boolean;
}) => {
  const title =
    reader?.kind === "transcript"
      ? " transcript "
      : reader?.kind === "tools"
        ? " tool calls "
        : reader?.kind === "toolDetail"
          ? " tool call "
          : " detail ";

  const queryText = parseQuery(query).text;

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      border
      borderColor={focused ? palette.borderActive : palette.border}
      title={title}
      paddingLeft={1}
      paddingRight={1}
    >
      {reader === null ? (
        match ? (
          <scrollbox ref={scrollRef} flexGrow={1}>
            <text content={`${match.provider} · ${shortProject(match.projectKey)} · ${match.role} · ${match.score.toFixed(1)}`} fg={palette.cyan} />
            <text content=" " />
            <text content={highlight(match.text, queryText)} />
          </scrollbox>
        ) : (
          <text content="—" fg={palette.muted} />
        )
      ) : reader.kind === "toolDetail" && toolDetail ? (
        <scrollbox ref={scrollRef} flexGrow={1}>
          <text content={`${toolDetail.toolName} · ${toolDetail.status}`} fg={palette.amber} />
          <text content="input" fg={palette.muted} />
          <text content={toolDetail.inputText || "—"} fg={palette.text} />
          <text content=" " />
          <text content="output" fg={palette.muted} />
          <text content={toolDetail.outputText || "—"} fg={palette.text} />
        </scrollbox>
      ) : reader.kind === "tools" ? (
        <scrollbox ref={scrollRef} flexGrow={1}>
          {tools.length === 0 ? (
            <text content="no tool calls" fg={palette.muted} />
          ) : (
            tools.map((tc, i) => (
              <text
                key={tc.id}
                content={`${i === toolSel ? "▎" : " "} ${tc.toolName} · ${tc.status} · #${tc.seq}`}
                fg={i === toolSel ? palette.amber : palette.muted}
              />
            ))
          )}
        </scrollbox>
      ) : (
        <scrollbox ref={scrollRef} flexGrow={1}>
          {transcript.length === 0 ? (
            <text content="loading…" fg={palette.muted} />
          ) : (
            transcript.map((m) => {
              const hit = parseQuery(query).text !== "" && m.text.toLowerCase().includes(queryText.toLowerCase());
              return (
                <box
                  key={m.seq}
                  flexDirection="column"
                  flexShrink={0}
                  ref={
                    hit
                      ? (r: BoxRenderable | null) => {
                          if (r) matchRefs.current.set(m.seq, r);
                          else matchRefs.current.delete(m.seq);
                        }
                      : undefined
                  }
                >
                  <text content={`[${m.seq}] ${m.role}`} fg={hit ? palette.amber : palette.cyan} />
                  <text content={highlight(m.text, queryText)} />
                  <text content=" " />
                </box>
              );
            })
          )}
        </scrollbox>
      )}
    </box>
  );
};

const KeyBar = ({ focus, toast }: { focus: Focus; toast: string | null }) => {
  const hints =
    focus === "search"
      ? "type search · ↑↓ select · enter read · tab list · esc clear"
      : focus === "reader"
        ? "j/k scroll · n/N match · t tools · e edit · y yank · esc back · q quit"
        : "j/k move · enter read · t tools · m mode · e edit · y yank · / search · ? help · q quit";
  return (
    <box height={1} flexShrink={0} backgroundColor={palette.panelRaised} paddingLeft={1} paddingRight={1} flexDirection="row">
      <text content={toast ? toast : hints} fg={toast ? palette.green : palette.muted} />
    </box>
  );
};

const HelpOverlay = () => (
  <box flexGrow={1} flexDirection="column" border borderColor={palette.borderActive} title=" keys " paddingLeft={2} paddingRight={2}>
    {[
      "search    type to search · ↑↓ or ctrl-n/p select · enter dive · tab list · ctrl-u clear · esc clear/quit",
      "list      j/k move · g/G ends · 1-9 jump · enter/s read · t tools · m mode · e $EDITOR · y/Y yank · / search",
      "reader    j/k scroll · space page · n/N match hop · t tools · i drill · e $EDITOR · y/Y yank · esc back",
      "filters   project:<key>  provider:<name>  role:user|assistant|reasoning   (or @project #provider)",
      "modes     lexical (instant) → semantic → fusion;  ~ = index reconciling, fell back to lexical",
      "global    ? help · q or ctrl-c quit",
    ].map((line, i) => (
      <text key={i} content={line} fg={palette.text} />
    ))}
  </box>
);

// ───────────────────────────────────────────────────────────────────── app

export const App = ({
  options,
  onExit,
  client: clientProp,
}: {
  readonly options: TuiOptions;
  readonly onExit: (exit?: TuiExit) => void;
  /** Injectable for tests; when omitted, resolves from the CLI's config. */
  readonly client?: QuasarClientLike | null;
}) => {
  const dims = useTerminalDimensions();
  const client = useMemo(
    () =>
      clientProp !== undefined
        ? clientProp
        : options.server
          ? new QuasarClient(options.server)
          : QuasarClient.fromConfig(),
    [clientProp, options.server],
  );

  const [query, setQuery] = useState(options.smokeQuery ?? "");
  const [mode, setMode] = useState<SearchMode>("lexical");
  const [results, setResults] = useState<readonly SearchMatch[]>([]);
  const [effectiveMode, setEffectiveMode] = useState<SearchMode>("lexical");
  const [fellBack, setFellBack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [focus, setFocus] = useState<Focus>("search");
  const [helpOpen, setHelpOpen] = useState(false);
  const [reader, setReader] = useState<Reader | null>(null);
  const [transcript, setTranscript] = useState<readonly MessageRow[]>([]);
  const [tools, setTools] = useState<readonly ToolCallRow[]>([]);
  const [toolSel, setToolSel] = useState(0);
  const [toolDetail, setToolDetail] = useState<ToolCallRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const matchRefs = useRef<Map<number, BoxRenderable>>(new Map());
  const matchPos = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirror state so the (stable) keyboard handler always reads fresh values.
  const live = {
    query,
    results,
    selected,
    focus,
    helpOpen,
    reader,
    mode,
    tools,
    toolSel,
    transcript,
  };
  const liveRef = useRef(live);
  liveRef.current = live;

  const flash = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1400);
  }, []);

  // Debounced search on [query, mode]. Async via the poll-based client, so the
  // render loop stays alive (animated "searching…", cancellable) during the wait.
  useEffect(() => {
    if (client === null) return;
    const parsed = parseQuery(query);
    if (parsed.text.trim() === "") {
      setResults([]);
      setError(null);
      setFellBack(false);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      // Intentionally unawaited — routeAsync attaches failure routing (no hang).
      routeAsync(
        (async () => {
          const run = (m: SearchMode) =>
            client.search(parsed.text, m, {
              limit: SEARCH_LIMIT,
              projectKey: parsed.projectKey,
              provider: parsed.provider,
              role: parsed.role,
              signal: controller.signal,
            });
          let res = await run(mode);
          let eff = mode;
          let fell = false;
          if (!res.ok && res.code === "SearchIndexNotReady" && mode !== "lexical") {
            res = await run("lexical");
            eff = "lexical";
            fell = true;
          }
          return { res, eff, fell } as const;
        })(),
        ({ res, eff, fell }) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setEffectiveMode(eff);
          setFellBack(fell);
          if (res.ok) {
            // Keep the selection on the same match across refinements when possible.
            const prevKey = liveRef.current.results[liveRef.current.selected]?.key;
            const keptIdx = prevKey ? res.value.findIndex((m) => m.key === prevKey) : -1;
            setResults(res.value);
            setSelected(keptIdx >= 0 ? keptIdx : 0);
            setError(null);
          } else {
            setResults([]);
            setError(res.code === "SearchIndexNotReady" ? "index reconciling — retry shortly" : res.message);
          }
        },
        (message) => {
          if (controller.signal.aborted) return;
          setLoading(false);
          setResults([]);
          setError(message);
        },
        "search failed",
      );
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, mode, client]);

  // Load a transcript when the reader opens on a session.
  // Intentionally unawaited under opentui — see routeAsync.
  useEffect(() => {
    if (client === null || reader === null) return;
    if (reader.kind !== "transcript") return;
    const controller = new AbortController();
    matchRefs.current = new Map();
    matchPos.current = 0;
    setTranscript([]);
    routeAsync(
      client.messages(reader.sessionId, { limit: 4000, signal: controller.signal }),
      (res) => {
        if (controller.signal.aborted) return;
        setTranscript(res.ok ? res.value : []);
        if (!res.ok) setError(res.message);
      },
      (message) => {
        if (controller.signal.aborted) return;
        setTranscript([]);
        setError(message);
      },
      "transcript load failed",
    );
    return () => controller.abort();
  }, [reader, client]);

  const loadTools = useCallback(
    (sessionId: string) => {
      if (client === null) return;
      setTools([]);
      setToolSel(0);
      // Intentionally unawaited under opentui — see routeAsync.
      routeAsync(
        client.toolCalls({ sessionId, limit: 500 }),
        (res) => {
          if (res.ok) {
            setTools(res.value);
            return;
          }
          setTools([]);
          setError(res.message);
        },
        (message) => {
          setTools([]);
          setError(message);
        },
        "tool-call load failed",
      );
    },
    [client],
  );

  const exitToEditor = useCallback(
    async (sessionId: string) => {
      if (client === null) return;
      const live = liveRef.current;
      let loaded: readonly MessageRow[] = live.reader?.sessionId === sessionId ? live.transcript : [];
      if (loaded.length === 0) {
        const r = await client.messages(sessionId, { limit: 8000 });
        loaded = r.ok ? r.value : [];
      }
      const file = writeTempFile(sessionId, transcriptToText(sessionId, loaded));
      onExit({ editorFile: file, editor: editorCommand() });
    },
    [client, onExit],
  );

  const apply = useCallback(
    (intent: Intent) => {
      const s = liveRef.current;
      const sel = s.results[s.selected];
      switch (intent.t) {
        case "type":
          setQuery((q) => q + intent.ch);
          break;
        case "backspace":
          setQuery((q) => q.slice(0, -1));
          break;
        case "clearQuery":
          setQuery("");
          break;
        case "deleteWord":
          setQuery((q) => q.replace(/\s*\S+\s*$/, ""));
          break;
        case "focusSearch":
          setFocus("search");
          break;
        case "focusList":
          if (s.results.length > 0) setFocus("list");
          break;
        case "move":
          setSelected((i) => Math.max(0, Math.min(s.results.length - 1, i + intent.delta)));
          break;
        case "first":
          if (s.focus === "reader") scrollRef.current?.scrollTo(0);
          else setSelected(0);
          break;
        case "last":
          if (s.focus === "reader") scrollRef.current?.scrollTo(1_000_000);
          else setSelected(Math.max(0, s.results.length - 1));
          break;
        case "jump":
          setSelected(Math.max(0, Math.min(s.results.length - 1, intent.index)));
          break;
        case "openReader":
          if (sel) {
            setReader({ kind: "transcript", sessionId: sel.sessionId });
            setFocus("reader");
          }
          break;
        case "toggleTools":
          if (s.reader && s.reader.kind === "tools") {
            setReader({ kind: "transcript", sessionId: s.reader.sessionId });
          } else if (s.reader) {
            loadTools(s.reader.sessionId);
            setReader({ kind: "tools", sessionId: s.reader.sessionId });
          } else if (sel) {
            loadTools(sel.sessionId);
            setReader({ kind: "tools", sessionId: sel.sessionId });
            setFocus("reader");
          }
          break;
        case "drill":
          if (s.reader?.kind === "tools" && s.tools[s.toolSel]) {
            setToolDetail(s.tools[s.toolSel]!);
            setReader({ kind: "toolDetail", sessionId: s.reader.sessionId });
          }
          break;
        case "scroll":
          if (s.reader?.kind === "tools") {
            const dir = intent.delta > 0 ? 1 : -1;
            setToolSel((i) => Math.max(0, Math.min(s.tools.length - 1, i + dir)));
          } else {
            scrollRef.current?.scrollBy(intent.delta);
          }
          break;
        case "matchNext":
        case "matchPrev": {
          const seqs = [...matchRefs.current.keys()].sort((a, b) => a - b);
          if (seqs.length > 0) {
            matchPos.current = (matchPos.current + (intent.t === "matchNext" ? 1 : -1) + seqs.length) % seqs.length;
            const r = matchRefs.current.get(seqs[matchPos.current]!);
            try {
              if (r) scrollRef.current?.scrollChildIntoView(r.id);
            } catch {
              // best-effort match hop
            }
          }
          break;
        }
        case "cycleMode":
          setMode((m) => nextMode(m));
          break;
        case "openEditor": {
          const sessionId = s.reader?.sessionId ?? sel?.sessionId;
          if (sessionId) {
            // Intentionally unawaited under opentui — rejection → toast, not hang.
            void exitToEditor(sessionId).catch((err: unknown) => {
              flash(errorMessage(err, "open editor failed"));
            });
          }
          break;
        }
        case "yankKey":
          if (sel) flash(copyToClipboard(`${sel.sessionId}:${sel.seq}:${sel.role}`) ? "yanked key" : "no clipboard");
          break;
        case "yankText":
          if (s.reader?.kind === "toolDetail" && toolDetail) {
            flash(copyToClipboard(`${toolDetail.inputText}\n\n${toolDetail.outputText}`) ? "yanked tool i/o" : "no clipboard");
          } else if (s.reader && s.transcript.length > 0) {
            flash(
              copyToClipboard(transcriptToText(s.reader.sessionId, s.transcript)) ? "yanked transcript" : "no clipboard",
            );
          } else if (sel) {
            flash(copyToClipboard(sel.text) ? "yanked text" : "no clipboard");
          }
          break;
        case "toggleHelp":
          setHelpOpen((h) => !h);
          break;
        case "back":
          if (s.reader?.kind === "toolDetail") setReader({ kind: "tools", sessionId: s.reader.sessionId });
          else if (s.reader?.kind === "tools") setReader({ kind: "transcript", sessionId: s.reader.sessionId });
          else {
            setReader(null);
            setFocus("list");
          }
          break;
        case "quit":
          onExit();
          break;
        case "none":
          break;
      }
    },
    [onExit, loadTools, exitToEditor, flash, toolDetail],
  );

  const onKey = useCallback(
    (raw: Key & { eventType?: string }) => {
      if (raw.eventType === "release") return;
      if (options.smoke) return;
      if (client === null) {
        if (raw.name === "q" || (raw.ctrl && raw.name === "c")) onExit();
        return;
      }
      const s = liveRef.current;
      apply(
        routeKey(raw, {
          focus: s.focus,
          hasResults: s.results.length > 0,
          queryEmpty: s.query === "",
          helpOpen: s.helpOpen,
        }),
      );
    },
    [apply, options.smoke, client, onExit],
  );
  useKeyboard(onKey);

  if (client === null) {
    return (
      <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg} paddingLeft={2} paddingTop={1}>
        <text content="quasar" fg={palette.amber} />
        <text content="no server configured." fg={palette.crimson} />
        <text content="set QUASAR_SERVER_URL or serverUrl in ~/.config/quasar/config.json" fg={palette.muted} />
        <text content="q to quit" fg={palette.muted} />
      </box>
    );
  }

  const bodyHeight = Math.max(2, dims.height - 3);
  const listVisible = Math.max(1, Math.floor((bodyHeight - 2) / 2));
  const listInner = Math.max(10, Math.floor(dims.width * 0.38) - 6);
  const filters = filterSummary(parseQuery(query));

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={palette.bg}>
      <Header
        effectiveMode={effectiveMode}
        fellBack={fellBack}
        count={results.length}
        filters={filters}
        error={error}
        loading={loading}
      />
      <Omnibox query={query} focused={focus === "search"} />
      {helpOpen ? (
        <HelpOverlay />
      ) : (
        <box flexDirection="row" flexGrow={1} minHeight={0}>
          <ResultList
            results={results}
            selected={selected}
            query={query}
            visible={listVisible}
            innerWidth={listInner}
            focused={focus === "list"}
            loading={loading}
          />
          <Detail
            reader={reader}
            match={results[selected]}
            query={query}
            transcript={transcript}
            tools={tools}
            toolSel={toolSel}
            toolDetail={toolDetail}
            scrollRef={scrollRef}
            matchRefs={matchRefs}
            focused={focus === "reader"}
          />
        </box>
      )}
      <KeyBar focus={focus} toast={toast} />
    </box>
  );
};
