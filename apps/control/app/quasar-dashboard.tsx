"use client";

import { useEffect, useMemo, useState } from "react";

export type DashboardData = {
  projects: Array<{
    projectIdentityKey: string;
    canonicalProjectIdentityKey: string;
    displayName: string;
    confidence: string;
    sessionCount: number;
  }>;
  importRuns: Array<{
    importRunId: string;
    status: string;
    sessionCount: number;
    eventCount: number;
    createdAt: number;
  }>;
  sessions: Array<{
    id: string;
    nativeSessionId?: string;
    title?: string;
    provider: string;
    agentName: string;
    machineId: string;
    projectIdentityKey: string;
    eventCount: number;
    updatedAt: number;
  }>;
  searchDiagnostics: {
    embeddingsConfigured: boolean;
  };
};

type SessionDetail = {
  session: {
    sessionId: string;
    title?: string;
    provider: string;
    agentName: string;
    machineId: string;
    canonicalProjectIdentityKey: string;
    sourcePath: string;
    nativeSessionId: string;
  };
  events: Array<{
    eventId: string;
    sequence: number;
    role: string;
    kind: string;
    contentText?: string;
    toolCallId?: string;
    timestamp?: string;
  }>;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    status?: string;
    eventId: string;
  }>;
};

const defaultApiBase = (
  process.env.NEXT_PUBLIC_QUASAR_API_BASE_URL ??
  process.env.NEXT_PUBLIC_CONVEX_SITE_URL ??
  ""
).replace(/\/+$/, "");

export function Dashboard({ initial }: { initial: DashboardData }) {
  const [data, setData] = useState(initial);
  const [apiBase, setApiBase] = useState(defaultApiBase);
  const [token, setToken] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"text" | "semantic" | "fusion">("fusion");
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
    const normalized = value.replace(/\/+$/, "");
    setApiBase(normalized);
    sessionStorage.setItem("quasar.apiBase", normalized);
  };

  const persistToken = (value: string) => {
    setToken(value);
    sessionStorage.setItem("quasar.token", value);
  };

  const endpoint = (path: string) => `${apiBase}${path}`;
  const authHeaders = () => ({
    ...(token.trim().length > 0 ? { authorization: `Bearer ${token.trim()}` } : {}),
  });

  const fetchJson = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(endpoint(path), {
      ...init,
      headers: {
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? `Request failed: ${path}`);
    return body;
  };

  const loadDashboard = async () => {
    setBusy(true);
    setError(null);
    try {
      const [projects, importRuns, sessions, health] = await Promise.all([
        fetchJson("/api/projects"),
        fetchJson("/api/import-runs"),
        fetchJson("/api/sessions?limit=30"),
        fetchJson("/api/health"),
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
      const response = await fetch(endpoint(`/api/search/${mode}`), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
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
      const body = await fetchJson(
        `/api/sessions/read?sessionId=${encodeURIComponent(sessionId)}`,
      );
      setSelectedSession(body as SessionDetail);
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : String(sessionError));
    } finally {
      setSessionBusy(false);
    }
  };

  const aliasProject = async () => {
    setError(null);
    try {
      const response = await fetch(endpoint("/api/projects/alias"), {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
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
      <section className="topbar">
        <div>
          <h1>Quasar</h1>
          <p>AI session repository across machines, agents, tools, and projects.</p>
        </div>
        <div className="top-actions">
          <div className="status-pill">
            RAG {data.searchDiagnostics.embeddingsConfigured ? "ready" : "unconfigured"}
          </div>
          <button type="button" onClick={loadDashboard} disabled={busy}>
            Refresh
          </button>
        </div>
      </section>

      <section className="control-row">
        <input
          value={apiBase}
          onChange={(event) => persistApiBase(event.target.value)}
          placeholder="Convex site API base, for example /quasar-api"
        />
        <input
          value={token}
          onChange={(event) => persistToken(event.target.value)}
          placeholder="Control token"
          type="password"
        />
      </section>

      <section className="search-row">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions, tool calls, bugs, decisions..."
        />
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}>
          <option value="fusion">Fusion</option>
          <option value="text">Text</option>
          <option value="semantic">Semantic</option>
        </select>
        <button type="button" onClick={runSearch} disabled={busy || query.trim() === ""}>
          {busy ? "Searching" : "Search"}
        </button>
      </section>

      {error !== null ? <div className="error">{error}</div> : null}

      <section className="grid">
        <div className="panel wide">
          <h2>Search Results</h2>
          <pre>{JSON.stringify(results ?? { matches: [] }, null, 2)}</pre>
        </div>

        <div className="panel">
          <h2>Project Alias</h2>
          <div className="alias-form">
            <select value={sourceAlias} onChange={(event) => setSourceAlias(event.target.value)}>
              <option value="">Source project</option>
              {data.projects.map((project) => (
                <option key={`source:${project.projectIdentityKey}`} value={project.projectIdentityKey}>
                  {project.displayName}
                </option>
              ))}
            </select>
            <select value={targetAlias} onChange={(event) => setTargetAlias(event.target.value)}>
              <option value="">Target project</option>
              {data.projects.map((project) => (
                <option key={`target:${project.projectIdentityKey}`} value={project.projectIdentityKey}>
                  {project.displayName}
                </option>
              ))}
            </select>
            <input
              value={aliasReason}
              onChange={(event) => setAliasReason(event.target.value)}
              placeholder="Merge reason"
            />
            <button
              type="button"
              onClick={aliasProject}
              disabled={sourceAlias === "" || targetAlias === "" || sourceAlias === targetAlias}
            >
              Merge
            </button>
          </div>
          <pre>{JSON.stringify(aliasResult ?? {}, null, 2)}</pre>
        </div>

        <div className="panel">
          <h2>Projects</h2>
          <div className="list">
            {data.projects.slice(0, 16).map((project) => (
              <div key={project.projectIdentityKey} className="row">
                <strong>{project.displayName}</strong>
                <span>{project.sessionCount} sessions</span>
                <small>{project.confidence}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <h2>Imports</h2>
          <div className="list">
            {recentRuns.map((run) => (
              <div key={run.importRunId} className="row">
                <strong>{run.status}</strong>
                <span>{run.sessionCount} sessions</span>
                <small>{new Date(run.createdAt).toLocaleString()}</small>
              </div>
            ))}
          </div>
        </div>

        <div className="panel wide">
          <h2>Recent Sessions</h2>
          <div className="table">
            {data.sessions.slice(0, 20).map((session) => (
              <div key={session.id} className="session-row">
                <span>{session.title ?? session.nativeSessionId ?? session.id}</span>
                <span>{session.provider}</span>
                <span>{session.eventCount} events</span>
                <span>{session.machineId}</span>
                <button type="button" onClick={() => readSession(session.id)} disabled={sessionBusy}>
                  Open
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="panel wide">
          <h2>Session Detail</h2>
          {selectedSession === null ? (
            <div className="empty">No session selected</div>
          ) : (
            <div className="detail">
              <div className="meta-grid">
                <span>{selectedSession.session.provider}</span>
                <span>{selectedSession.session.agentName}</span>
                <span>{selectedSession.session.machineId}</span>
                <span>{selectedSession.session.canonicalProjectIdentityKey}</span>
                <span>{selectedSession.session.sourcePath}</span>
              </div>
              <div className="timeline">
                {selectedSession.events.map((event) => (
                  <div key={event.eventId} className="event-row">
                    <span>{event.sequence}</span>
                    <strong>{event.role}</strong>
                    <span>{event.kind}</span>
                    <p>{event.contentText ?? event.toolCallId ?? event.eventId}</p>
                  </div>
                ))}
              </div>
              <h2>Tool Calls</h2>
              <div className="table">
                {selectedSession.toolCalls.map((tool) => (
                  <div key={tool.toolCallId} className="tool-row">
                    <span>{tool.toolName}</span>
                    <span>{tool.status ?? "unknown"}</span>
                    <span>{tool.toolCallId}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <style jsx>{`
        .shell {
          width: min(1440px, 100%);
          margin: 0 auto;
          padding: 24px;
        }
        .topbar {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 24px;
          padding: 18px 0 22px;
          border-bottom: 1px solid var(--line);
        }
        h1 {
          margin: 0;
          font-size: 30px;
          letter-spacing: 0;
        }
        p {
          margin: 6px 0 0;
          color: var(--muted);
        }
        .status-pill {
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 8px 10px;
          color: var(--accent);
          background: var(--panel);
          white-space: nowrap;
        }
        .top-actions {
          display: flex;
          gap: 10px;
          align-items: center;
        }
        .search-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) 150px 120px;
          gap: 10px;
          margin: 22px 0;
        }
        .control-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(180px, 320px);
          gap: 10px;
          margin: 18px 0 0;
        }
        input,
        select,
        button {
          border: 1px solid var(--line);
          border-radius: 6px;
          color: var(--text);
          background: var(--panel);
          padding: 11px 12px;
        }
        button {
          background: var(--accent);
          color: #07110d;
          font-weight: 700;
          cursor: pointer;
        }
        button:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }
        .grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 16px;
        }
        .panel {
          border: 1px solid var(--line);
          border-radius: 8px;
          background: var(--panel);
          padding: 16px;
          min-width: 0;
        }
        .wide {
          grid-column: 1 / -1;
        }
        h2 {
          margin: 0 0 12px;
          font-size: 16px;
          letter-spacing: 0;
        }
        pre {
          margin: 0;
          max-height: 420px;
          overflow: auto;
          border-radius: 6px;
          background: #0b0d10;
          padding: 12px;
          color: #cfe8db;
        }
        .list {
          display: grid;
          gap: 8px;
        }
        .row,
        .session-row {
          display: grid;
          grid-template-columns: minmax(0, 1fr) auto auto;
          gap: 10px;
          align-items: center;
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 10px;
          background: var(--panel-2);
        }
        .session-row {
          grid-template-columns: minmax(0, 1fr) 120px 100px 220px 92px;
        }
        .tool-row {
          display: grid;
          grid-template-columns: 220px 120px minmax(0, 1fr);
          gap: 10px;
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 10px;
          background: var(--panel-2);
        }
        .alias-form {
          display: grid;
          grid-template-columns: 1fr;
          gap: 8px;
          margin-bottom: 12px;
        }
        .empty {
          color: var(--muted);
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 14px;
          background: var(--panel-2);
        }
        .meta-grid {
          display: grid;
          grid-template-columns: repeat(5, minmax(0, 1fr));
          gap: 8px;
          margin-bottom: 14px;
        }
        .meta-grid span {
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 8px;
          background: var(--panel-2);
        }
        .timeline {
          display: grid;
          gap: 8px;
          margin-bottom: 18px;
        }
        .event-row {
          display: grid;
          grid-template-columns: 48px 110px 120px minmax(0, 1fr);
          gap: 10px;
          align-items: start;
          border: 1px solid var(--line);
          border-radius: 6px;
          padding: 10px;
          background: var(--panel-2);
        }
        .event-row p {
          margin: 0;
          color: var(--text);
          overflow-wrap: anywhere;
        }
        strong,
        span,
        small {
          min-width: 0;
          overflow-wrap: anywhere;
        }
        small {
          color: var(--muted);
        }
        .error {
          border: 1px solid #7c2d2d;
          background: #301616;
          color: #ffd8d8;
          border-radius: 6px;
          padding: 10px 12px;
          margin-bottom: 16px;
        }
        @media (max-width: 800px) {
          .topbar,
          .search-row,
          .grid {
            grid-template-columns: 1fr;
          }
          .topbar {
            display: grid;
            align-items: start;
          }
          .top-actions {
            align-items: stretch;
          }
          .session-row {
            grid-template-columns: 1fr;
          }
          .control-row,
          .meta-grid,
          .event-row,
          .tool-row {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </main>
  );
}
