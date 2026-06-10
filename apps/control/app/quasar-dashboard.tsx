"use client";

import { useEffect, useMemo, useState } from "react";

import {
  createDashboardClient,
  defaultApiBase,
  normalizeApiBase,
} from "./quasar-dashboard-api";
import {
  ConnectionControls,
  DashboardHeader,
  BrowseFiltersPanel,
  ProjectAliasPanel,
  ProjectsPanel,
  RecentSessionsPanel,
  SearchControls,
  SearchResultsPanel,
  SessionDetailPanel,
} from "./quasar-dashboard-sections";
import { DashboardStyles } from "./quasar-dashboard-styles";
import type {
  DashboardData,
  ListEnvelope,
  SearchMode,
  SessionBrowseFilters,
  SessionDetail,
  SessionSummary,
} from "./quasar-dashboard-types";

export type { DashboardData } from "./quasar-dashboard-types";

type SessionDetailPage =
  | "events"
  | "contentBlocks"
  | "sessionEdges"
  | "toolCalls"
  | "usageRecords"
  | "artifacts";
const useConnectionSettings = () => {
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [token, setToken] = useState("");

  useEffect(() => {
    setApiBase(sessionStorage.getItem("quasar.apiBase") ?? defaultApiBase);
    setToken(sessionStorage.getItem("quasar.token") ?? "");
  }, []);

  const persistApiBase = (value: string) => {
    const normalized = normalizeApiBase(value);
    setApiBase(normalized);
    sessionStorage.setItem("quasar.apiBase", normalized);
  };

  const persistToken = (value: string) => {
    setToken(value);
    sessionStorage.setItem("quasar.token", value);
  };

  return { apiBase, token, persistApiBase, persistToken };
};

export function Dashboard({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<SearchMode>("fusion");
  const [filters, setFilters] = useState<SessionBrowseFilters>({
    projectIdentityKey: "",
    provider: "",
    agentName: "",
    machineId: "",
  });
  const [results, setResults] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
  const [sessionCursor, setSessionCursor] = useState<string>("");
  const [sessionBusy, setSessionBusy] = useState(false);
  const [sourceAlias, setSourceAlias] = useState("");
  const [targetAlias, setTargetAlias] = useState("");
  const [aliasReason, setAliasReason] = useState("");
  const [aliasResult, setAliasResult] = useState<unknown>(null);
  const { apiBase, token, persistApiBase, persistToken } = useConnectionSettings();
  const client = useMemo(() => createDashboardClient(apiBase, token), [apiBase, token]);

  const loadDashboard = async () => {
    setBusy(true);
    setError(null);
    try {
      const [projectsPage, sessionsPage, health] = await Promise.all([
        client.fetchJson<ListEnvelope<DashboardData["projects"][number]>>("/api/projects?limit=100"),
        client.fetchJson<ListEnvelope<SessionSummary>>(sessionsPath(filters, "")),
        client.fetchJson<{ embeddingsConfigured?: boolean }>("/api/health"),
      ]);
      setData({
        projects: projectsPage.items,
        sessions: sessionsPage.items,
        searchDiagnostics: {
          embeddingsConfigured: Boolean(health.embeddingsConfigured),
        },
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  };

  const loadSessions = async (nextFilters: SessionBrowseFilters, cursor = "") => {
    setBusy(true);
    setError(null);
    try {
      const page = await client.fetchJson<ListEnvelope<SessionSummary>>(
        sessionsPath(nextFilters, cursor),
      );
      setSessionCursor(page.isDone ? "" : page.continueCursor);
      setData((current) => ({
        ...current,
        sessions: cursor === "" ? page.items : [...current.sessions, ...page.items],
      }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setBusy(false);
    }
  };

  const updateFilters = (nextFilters: SessionBrowseFilters) => {
    setFilters(nextFilters);
    setSessionCursor("");
    void loadSessions(nextFilters, "");
  };

  const runSearch = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(client.endpoint(`/api/search/${mode}`), {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({
          query,
          limit: 12,
          projectIdentityKey: filters.projectIdentityKey || undefined,
          provider: filters.provider || undefined,
          agentName: filters.agentName || undefined,
          machineId: filters.machineId || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Search failed");
      setResults(body);
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : String(searchError));
    } finally {
      setBusy(false);
    }
  };

  const readSession = async (
    sessionId: string,
    page?: SessionDetailPage,
  ) => {
    setSessionBusy(true);
    setError(null);
    try {
      const current = selectedSession?.session.sessionId === sessionId ? selectedSession : null;
      const body = await client.fetchJson<SessionDetail>(
        sessionDetailPath(sessionId, current, page),
      );
      setSelectedSession(
        current === null || page === undefined ? body : mergeSessionDetail(current, body, page),
      );
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setSessionBusy(false);
    }
  };

  const aliasProject = async () => {
    setError(null);
    try {
      const response = await fetch(client.endpoint("/api/projects/alias"), {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({
          sourceProjectIdentityKey: sourceAlias,
          targetProjectIdentityKey: targetAlias,
          reason: aliasReason || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Project alias failed");
      setAliasResult(body);
      await loadDashboard();
    } catch (aliasError) {
      setError(aliasError instanceof Error ? aliasError.message : String(aliasError));
    }
  };

  const loadSessionPage = (page: SessionDetailPage) => {
    if (selectedSession === null) return;
    void readSession(selectedSession.session.sessionId, page);
  };

  return (
    <main className="shell">
      <DashboardTop
        data={data}
        apiBase={apiBase}
        token={token}
        query={query}
        mode={mode}
        busy={busy}
        onRefresh={loadDashboard}
        onApiBaseChange={persistApiBase}
        onTokenChange={persistToken}
        onQueryChange={setQuery}
        onModeChange={setMode}
        onSearch={runSearch}
      />
      {error !== null ? <div className="error">{error}</div> : null}
      <DashboardPanels
        data={data}
        results={results}
        filters={filters}
        selectedSession={selectedSession}
        sessionCursor={sessionCursor}
        busy={busy}
        sessionBusy={sessionBusy}
        sourceAlias={sourceAlias}
        targetAlias={targetAlias}
        aliasReason={aliasReason}
        aliasResult={aliasResult}
        onReadSession={readSession}
        onFiltersChange={updateFilters}
        onLoadMoreSessions={() => void loadSessions(filters, sessionCursor)}
        onLoadSessionEvents={() => loadSessionPage("events")}
        onLoadSessionContentBlocks={() => loadSessionPage("contentBlocks")}
        onLoadSessionEdges={() => loadSessionPage("sessionEdges")}
        onLoadSessionToolCalls={() => loadSessionPage("toolCalls")}
        onLoadSessionUsage={() => loadSessionPage("usageRecords")}
        onLoadSessionArtifacts={() => loadSessionPage("artifacts")}
        onSourceAliasChange={setSourceAlias}
        onTargetAliasChange={setTargetAlias}
        onAliasReasonChange={setAliasReason}
        onAliasProject={aliasProject}
      />

      <DashboardStyles />
    </main>
  );
}

const sessionsPath = (filters: SessionBrowseFilters, cursor: string) => {
  const params = new URLSearchParams({ limit: "100" });
  if (filters.projectIdentityKey !== "") params.set("projectIdentityKey", filters.projectIdentityKey);
  if (filters.provider !== "") params.set("provider", filters.provider);
  if (filters.agentName !== "") params.set("agentName", filters.agentName);
  if (filters.machineId !== "") params.set("machineId", filters.machineId);
  if (cursor !== "") params.set("cursor", cursor);
  return `/api/sessions?${params.toString()}`;
};

const sessionCursorParams: Record<SessionDetailPage, string> = {
  events: "eventCursor",
  contentBlocks: "contentBlockCursor",
  sessionEdges: "edgeCursor",
  toolCalls: "toolCallCursor",
  usageRecords: "usageCursor",
  artifacts: "artifactCursor",
};
const sessionDetailPath = (
  sessionId: string,
  current: SessionDetail | null,
  page?: SessionDetailPage,
) => {
  const params = new URLSearchParams({ sessionId, limit: "50" });
  const cursor = page === undefined ? "" : (current?.pagination?.[page]?.continueCursor ?? "");
  if (page !== undefined && cursor !== "") params.set(sessionCursorParams[page], cursor);
  return `/api/sessions/read?${params.toString()}`;
};
const mergeSessionDetail = (
  current: SessionDetail,
  next: SessionDetail,
  page: SessionDetailPage,
): SessionDetail => ({
  ...next,
  events: page === "events" ? [...current.events, ...next.events] : current.events,
  contentBlocks:
    page === "contentBlocks"
      ? appendOptional(current.contentBlocks, next.contentBlocks)
      : current.contentBlocks,
  sessionEdges:
    page === "sessionEdges"
      ? appendOptional(current.sessionEdges, next.sessionEdges)
      : current.sessionEdges,
  toolCalls: page === "toolCalls" ? [...current.toolCalls, ...next.toolCalls] : current.toolCalls,
  usageRecords:
    page === "usageRecords"
      ? appendOptional(current.usageRecords, next.usageRecords)
      : current.usageRecords,
  artifacts:
    page === "artifacts" ? appendOptional(current.artifacts, next.artifacts) : current.artifacts,
  views: current.views,
  pagination: mergeSessionPagination(current.pagination, next.pagination, page),
});
const mergeSessionPagination = (
  current: SessionDetail["pagination"],
  next: SessionDetail["pagination"],
  page: SessionDetailPage,
): SessionDetail["pagination"] => ({
  ...current,
  [page]: next?.[page] ?? current?.[page],
});
function appendOptional<T>(left: T[] | undefined, right: T[] | undefined) {
  const merged = [...(left ?? []), ...(right ?? [])];
  return merged.length === 0 && left === undefined && right === undefined ? undefined : merged;
}

type DashboardTopProps = {
  data: DashboardData;
  apiBase: string;
  token: string;
  query: string;
  mode: SearchMode;
  busy: boolean;
  onRefresh: () => void;
  onApiBaseChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onQueryChange: (value: string) => void;
  onModeChange: (value: SearchMode) => void;
  onSearch: () => void;
};

function DashboardTop(props: DashboardTopProps) {
  return (
    <>
      <DashboardHeader
        embeddingsConfigured={props.data.searchDiagnostics.embeddingsConfigured}
        busy={props.busy}
        onRefresh={props.onRefresh}
      />
      <ConnectionControls
        apiBase={props.apiBase}
        token={props.token}
        onApiBaseChange={props.onApiBaseChange}
        onTokenChange={props.onTokenChange}
      />
      <SearchControls
        query={props.query}
        mode={props.mode}
        busy={props.busy}
        onQueryChange={props.onQueryChange}
        onModeChange={props.onModeChange}
        onSearch={props.onSearch}
      />
    </>
  );
}

type DashboardPanelsProps = {
  data: DashboardData;
  results: unknown;
  filters: SessionBrowseFilters;
  selectedSession: SessionDetail | null;
  sessionCursor: string;
  busy: boolean;
  sessionBusy: boolean;
  sourceAlias: string;
  targetAlias: string;
  aliasReason: string;
  aliasResult: unknown;
  onReadSession: (sessionId: string, page?: SessionDetailPage) => void;
  onLoadMoreSessions: () => void;
  onLoadSessionEvents: () => void;
  onLoadSessionContentBlocks: () => void;
  onLoadSessionEdges: () => void;
  onLoadSessionToolCalls: () => void;
  onLoadSessionUsage: () => void;
  onLoadSessionArtifacts: () => void;
  onFiltersChange: (filters: SessionBrowseFilters) => void;
  onSourceAliasChange: (value: string) => void;
  onTargetAliasChange: (value: string) => void;
  onAliasReasonChange: (value: string) => void;
  onAliasProject: () => void;
};

function DashboardPanels(props: DashboardPanelsProps) {
  const filteredSessions = props.data.sessions
    .filter((session) =>
      props.filters.projectIdentityKey === ""
        ? true
        : session.projectIdentityKey === props.filters.projectIdentityKey,
    )
    .filter((session) =>
      props.filters.provider === "" ? true : session.provider === props.filters.provider,
    )
    .filter((session) =>
      props.filters.agentName === "" ? true : session.agentName === props.filters.agentName,
    )
    .filter((session) =>
      props.filters.machineId === "" ? true : session.machineId === props.filters.machineId,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);

  return (
    <section className="grid">
      <SearchResultsPanel results={props.results} />
      <BrowseFiltersPanel
        filters={props.filters}
        projects={props.data.projects}
        sessions={props.data.sessions}
        onFiltersChange={props.onFiltersChange}
      />
      <ProjectAliasPanel
        projects={props.data.projects}
        sourceAlias={props.sourceAlias}
        targetAlias={props.targetAlias}
        aliasReason={props.aliasReason}
        aliasResult={props.aliasResult}
        onSourceAliasChange={props.onSourceAliasChange}
        onTargetAliasChange={props.onTargetAliasChange}
        onAliasReasonChange={props.onAliasReasonChange}
        onAliasProject={props.onAliasProject}
      />
      <ProjectsPanel projects={props.data.projects} />
      <RecentSessionsPanel
        sessions={filteredSessions}
        sessionBusy={props.sessionBusy}
        onReadSession={props.onReadSession}
        onLoadMore={props.onLoadMoreSessions}
        hasMore={props.sessionCursor !== ""}
      />
      <SessionDetailPanel
        selectedSession={props.selectedSession}
        sessionBusy={props.sessionBusy}
        onLoadEvents={props.onLoadSessionEvents}
        onLoadContentBlocks={props.onLoadSessionContentBlocks}
        onLoadEdges={props.onLoadSessionEdges}
        onLoadToolCalls={props.onLoadSessionToolCalls}
        onLoadUsage={props.onLoadSessionUsage}
        onLoadArtifacts={props.onLoadSessionArtifacts}
      />
    </section>
  );
}
