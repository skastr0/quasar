import type {
  ImportRunSummary,
  ProjectSummary,
  SearchMode,
  SessionBrowseFilters,
  SessionDetail,
  SessionSummary,
} from "./quasar-dashboard-types";

type HeaderProps = {
  embeddingsConfigured: boolean;
  busy: boolean;
  onRefresh: () => void;
};

export function DashboardHeader({ embeddingsConfigured, busy, onRefresh }: HeaderProps) {
  return (
    <section className="topbar">
      <div>
        <h1>Quasar</h1>
        <p>AI session repository across machines, agents, tools, and projects.</p>
      </div>
      <div className="top-actions">
        <div className="status-pill">RAG {embeddingsConfigured ? "ready" : "unconfigured"}</div>
        <button type="button" onClick={onRefresh} disabled={busy}>
          Refresh
        </button>
      </div>
    </section>
  );
}

type ConnectionControlsProps = {
  apiBase: string;
  token: string;
  onApiBaseChange: (value: string) => void;
  onTokenChange: (value: string) => void;
};

export function ConnectionControls({
  apiBase,
  token,
  onApiBaseChange,
  onTokenChange,
}: ConnectionControlsProps) {
  return (
    <section className="control-row">
      <input
        value={apiBase}
        onChange={(event) => onApiBaseChange(event.target.value)}
        placeholder="Convex site API base, for example /quasar-api"
      />
      <input
        value={token}
        onChange={(event) => onTokenChange(event.target.value)}
        placeholder="Control token"
        type="password"
      />
    </section>
  );
}

type SearchControlsProps = {
  query: string;
  mode: SearchMode;
  busy: boolean;
  onQueryChange: (value: string) => void;
  onModeChange: (value: SearchMode) => void;
  onSearch: () => void;
};

export function SearchControls({
  query,
  mode,
  busy,
  onQueryChange,
  onModeChange,
  onSearch,
}: SearchControlsProps) {
  return (
    <section className="search-row">
      <input
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        placeholder="Search sessions, tool calls, bugs, decisions..."
      />
      <select value={mode} onChange={(event) => onModeChange(event.target.value as SearchMode)}>
        <option value="fusion">Fusion</option>
        <option value="text">Text</option>
        <option value="semantic">Semantic</option>
      </select>
      <button type="button" onClick={onSearch} disabled={busy || query.trim() === ""}>
        {busy ? "Searching" : "Search"}
      </button>
    </section>
  );
}

export function SearchResultsPanel({ results }: { results: unknown }) {
  return (
    <div className="panel wide">
      <h2>Search Results</h2>
      <pre>{JSON.stringify(results ?? { matches: [] }, null, 2)}</pre>
    </div>
  );
}

type BrowseFiltersPanelProps = {
  filters: SessionBrowseFilters;
  projects: ProjectSummary[];
  sessions: SessionSummary[];
  onFiltersChange: (filters: SessionBrowseFilters) => void;
};

export function BrowseFiltersPanel({
  filters,
  projects,
  sessions,
  onFiltersChange,
}: BrowseFiltersPanelProps) {
  const providers = unique(sessions.map((session) => session.provider));
  const agents = unique(sessions.map((session) => session.agentName));
  const machines = unique(sessions.map((session) => session.machineId));
  const update = (patch: Partial<SessionBrowseFilters>) =>
    onFiltersChange({ ...filters, ...patch });
  return (
    <div className="panel wide">
      <h2>Browse Filters</h2>
      <div className="filter-row">
        <select
          value={filters.projectIdentityKey}
          onChange={(event) => update({ projectIdentityKey: event.target.value })}
        >
          <option value="">All projects</option>
          {projects.map((project) => (
            <option key={project.projectIdentityKey} value={project.projectIdentityKey}>
              {project.displayName}
            </option>
          ))}
        </select>
        <select value={filters.provider} onChange={(event) => update({ provider: event.target.value })}>
          <option value="">All providers</option>
          {providers.map((provider) => (
            <option key={provider} value={provider}>
              {provider}
            </option>
          ))}
        </select>
        <select value={filters.agentName} onChange={(event) => update({ agentName: event.target.value })}>
          <option value="">All agents</option>
          {agents.map((agent) => (
            <option key={agent} value={agent}>
              {agent}
            </option>
          ))}
        </select>
        <select value={filters.machineId} onChange={(event) => update({ machineId: event.target.value })}>
          <option value="">All machines</option>
          {machines.map((machine) => (
            <option key={machine} value={machine}>
              {machine}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

type ProjectAliasPanelProps = {
  projects: ProjectSummary[];
  sourceAlias: string;
  targetAlias: string;
  aliasReason: string;
  aliasResult: unknown;
  onSourceAliasChange: (value: string) => void;
  onTargetAliasChange: (value: string) => void;
  onAliasReasonChange: (value: string) => void;
  onAliasProject: () => void;
};

export function ProjectAliasPanel({
  projects,
  sourceAlias,
  targetAlias,
  aliasReason,
  aliasResult,
  onSourceAliasChange,
  onTargetAliasChange,
  onAliasReasonChange,
  onAliasProject,
}: ProjectAliasPanelProps) {
  return (
    <div className="panel">
      <h2>Project Alias</h2>
      <div className="alias-form">
        <select value={sourceAlias} onChange={(event) => onSourceAliasChange(event.target.value)}>
          <option value="">Source project</option>
          {projects.map((project) => (
            <option key={`source:${project.projectIdentityKey}`} value={project.projectIdentityKey}>
              {project.displayName}
            </option>
          ))}
        </select>
        <select value={targetAlias} onChange={(event) => onTargetAliasChange(event.target.value)}>
          <option value="">Target project</option>
          {projects.map((project) => (
            <option key={`target:${project.projectIdentityKey}`} value={project.projectIdentityKey}>
              {project.displayName}
            </option>
          ))}
        </select>
        <input
          value={aliasReason}
          onChange={(event) => onAliasReasonChange(event.target.value)}
          placeholder="Merge reason"
        />
        <button
          type="button"
          onClick={onAliasProject}
          disabled={sourceAlias === "" || targetAlias === "" || sourceAlias === targetAlias}
        >
          Merge
        </button>
      </div>
      <pre>{JSON.stringify(aliasResult ?? {}, null, 2)}</pre>
    </div>
  );
}

export function ProjectsPanel({ projects }: { projects: ProjectSummary[] }) {
  return (
    <div className="panel">
      <h2>Projects</h2>
      <div className="list">
        {projects.slice(0, 16).map((project) => (
          <div key={project.projectIdentityKey} className="row">
            <strong>{project.displayName}</strong>
            <span>{project.sessionCount} sessions</span>
            <small>{project.confidence}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ImportsPanel({ runs }: { runs: ImportRunSummary[] }) {
  return (
    <div className="panel">
      <h2>Imports</h2>
      <div className="list">
        {runs.map((run) => (
          <div key={run.importRunId} className="row">
            <strong>{run.status}</strong>
            <span>{run.sessionCount} sessions</span>
            <span>{run.contentBlockCount ?? 0} blocks</span>
            <span>{run.artifactCount ?? 0} artifacts</span>
            <small>{new Date(run.createdAt).toLocaleString()}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

type RecentSessionsPanelProps = {
  sessions: SessionSummary[];
  sessionBusy: boolean;
  onReadSession: (sessionId: string) => void;
};

export function RecentSessionsPanel({
  sessions,
  sessionBusy,
  onReadSession,
}: RecentSessionsPanelProps) {
  return (
    <div className="panel wide">
      <h2>Recent Sessions</h2>
      <div className="table">
        {sessions.slice(0, 20).map((session) => (
          <div key={session.id} className="session-row">
            <span>{session.title ?? session.nativeSessionId ?? session.id}</span>
            <span>{session.provider}</span>
            <span>{session.agentName}</span>
            <span>{session.eventCount} events</span>
            <span>{session.projectIdentityKey}</span>
            <span>{session.machineId}</span>
            <small>{new Date(session.updatedAt).toLocaleString()}</small>
            <button type="button" onClick={() => onReadSession(session.id)} disabled={sessionBusy}>
              Open
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SessionDetailPanel({ selectedSession }: { selectedSession: SessionDetail | null }) {
  return (
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
          <div className="graph-counts">
            <span>{selectedSession.events.length} events</span>
            <span>{selectedSession.contentBlocks?.length ?? 0} blocks</span>
            <span>{selectedSession.sessionEdges?.length ?? 0} edges</span>
            <span>{selectedSession.toolCalls.length} tools</span>
            <span>{selectedSession.usageRecords?.length ?? 0} usage</span>
            <span>{selectedSession.artifacts?.length ?? 0} artifacts</span>
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
          <h2>Artifacts</h2>
          <div className="table">
            {(selectedSession.artifacts ?? []).map((artifact) => (
              <div key={artifact.artifactId} className="artifact-row">
                <span>{artifact.kind}</span>
                <span>{artifact.path ?? artifact.sourcePath ?? artifact.artifactId}</span>
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
  );
}

const unique = (values: string[]) =>
  [...new Set(values.filter((value) => value.length > 0))].sort((left, right) =>
    left.localeCompare(right),
  );
