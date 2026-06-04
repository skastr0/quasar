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
  ImportsPanel,
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
  SearchMode,
  SessionDetail,
  SessionSummary,
} from "./quasar-dashboard-types";

export type { DashboardData } from "./quasar-dashboard-types";

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
  const [results, setResults] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<SessionDetail | null>(null);
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
      const [projects, importRuns, sessions, health] = await Promise.all([
        client.fetchJson<DashboardData["projects"]>("/api/projects"),
        client.fetchJson<DashboardData["importRuns"]>("/api/import-runs"),
        client.fetchJson<SessionSummary[]>("/api/sessions?limit=30"),
        client.fetchJson<{ embeddingsConfigured?: boolean }>("/api/health"),
      ]);
      setData({
        projects,
        importRuns,
        sessions,
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

  const runSearch = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(client.endpoint(`/api/search/${mode}`), {
        method: "POST",
        headers: { "content-type": "application/json", ...client.authHeaders() },
        body: JSON.stringify({ query, limit: 12 }),
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

  const readSession = async (sessionId: string) => {
    setSessionBusy(true);
    setError(null);
    try {
      const body = await client.fetchJson<SessionDetail>(
        `/api/sessions/read?sessionId=${encodeURIComponent(sessionId)}`,
      );
      setSelectedSession(body);
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
        selectedSession={selectedSession}
        sessionBusy={sessionBusy}
        sourceAlias={sourceAlias}
        targetAlias={targetAlias}
        aliasReason={aliasReason}
        aliasResult={aliasResult}
        onReadSession={readSession}
        onSourceAliasChange={setSourceAlias}
        onTargetAliasChange={setTargetAlias}
        onAliasReasonChange={setAliasReason}
        onAliasProject={aliasProject}
      />

      <DashboardStyles />
    </main>
  );
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
  selectedSession: SessionDetail | null;
  sessionBusy: boolean;
  sourceAlias: string;
  targetAlias: string;
  aliasReason: string;
  aliasResult: unknown;
  onReadSession: (sessionId: string) => void;
  onSourceAliasChange: (value: string) => void;
  onTargetAliasChange: (value: string) => void;
  onAliasReasonChange: (value: string) => void;
  onAliasProject: () => void;
};

function DashboardPanels(props: DashboardPanelsProps) {
  const recentRuns = [...props.data.importRuns]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, 6);

  return (
    <section className="grid">
      <SearchResultsPanel results={props.results} />
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
      <ImportsPanel runs={recentRuns} />
      <RecentSessionsPanel
        sessions={props.data.sessions}
        sessionBusy={props.sessionBusy}
        onReadSession={props.onReadSession}
      />
      <SessionDetailPanel selectedSession={props.selectedSession} />
    </section>
  );
}
