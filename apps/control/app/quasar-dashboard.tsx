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
  ImportRunSummary,
  SearchMode,
  SessionDetail,
  SessionSummary,
} from "./quasar-dashboard-types";

export type { DashboardData } from "./quasar-dashboard-types";

export function Dashboard({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState(initial);
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [token, setToken] = useState("");
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

  const client = useMemo(() => createDashboardClient(apiBase, token), [apiBase, token]);

  const loadDashboard = async () => {
    setBusy(true);
    setError(null);
    try {
      const [projects, importRuns, sessions, health] = await Promise.all([
        client.fetchJson<DashboardData["projects"]>("/api/projects"),
        client.fetchJson<ImportRunSummary[]>("/api/import-runs"),
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

  const recentRuns = useMemo(
    () =>
      [...data.importRuns]
        .sort((left, right) => right.createdAt - left.createdAt)
        .slice(0, 6),
    [data.importRuns],
  );

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
      <DashboardHeader
        embeddingsConfigured={data.searchDiagnostics.embeddingsConfigured}
        busy={busy}
        onRefresh={loadDashboard}
      />
      <ConnectionControls
        apiBase={apiBase}
        token={token}
        onApiBaseChange={persistApiBase}
        onTokenChange={persistToken}
      />
      <SearchControls
        query={query}
        mode={mode}
        busy={busy}
        onQueryChange={setQuery}
        onModeChange={setMode}
        onSearch={runSearch}
      />

      {error !== null ? <div className="error">{error}</div> : null}

      <section className="grid">
        <SearchResultsPanel results={results} />
        <ProjectAliasPanel
          projects={data.projects}
          sourceAlias={sourceAlias}
          targetAlias={targetAlias}
          aliasReason={aliasReason}
          aliasResult={aliasResult}
          onSourceAliasChange={setSourceAlias}
          onTargetAliasChange={setTargetAlias}
          onAliasReasonChange={setAliasReason}
          onAliasProject={aliasProject}
        />
        <ProjectsPanel projects={data.projects} />
        <ImportsPanel runs={recentRuns} />
        <RecentSessionsPanel
          sessions={data.sessions}
          sessionBusy={sessionBusy}
          onReadSession={readSession}
        />
        <SessionDetailPanel selectedSession={selectedSession} />
      </section>

      <DashboardStyles />
    </main>
  );
}
