export type ProjectSummary = {
  projectIdentityKey: string;
  canonicalProjectIdentityKey: string;
  displayName: string;
  confidence: string;
  sessionCount: number;
};

export type ImportRunSummary = {
  importRunId: string;
  status: string;
  sessionCount: number;
  eventCount: number;
  toolCallCount?: number;
  contentBlockCount?: number;
  sessionEdgeCount?: number;
  usageRecordCount?: number;
  artifactCount?: number;
  createdAt: number;
};

export type SessionSummary = {
  id: string;
  nativeSessionId?: string;
  title?: string;
  provider: string;
  agentName: string;
  machineId: string;
  projectIdentityKey: string;
  eventCount: number;
  updatedAt: number;
};

export type SessionBrowseFilters = {
  projectIdentityKey: string;
  provider: string;
  agentName: string;
  machineId: string;
};

export type DashboardData = {
  projects: ProjectSummary[];
  importRuns: ImportRunSummary[];
  sessions: SessionSummary[];
  searchDiagnostics: {
    embeddingsConfigured: boolean;
  };
};

export type SessionDetail = {
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
    contentBlocks?: unknown[];
  }>;
  contentBlocks?: unknown[];
  sessionEdges?: Array<{ edgeId: string; kind: string; fromEventId?: string; toEventId?: string }>;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    status?: string;
    eventId: string;
  }>;
  usageRecords?: unknown[];
  artifacts?: Array<{ artifactId: string; kind: string; path?: string; sourcePath?: string }>;
  views?: {
    chronological?: unknown[];
    branch?: Array<{ eventId: string }>;
    toolExpanded?: unknown[];
    selected?: string;
  };
};

export type SearchMode = "text" | "semantic" | "fusion";
