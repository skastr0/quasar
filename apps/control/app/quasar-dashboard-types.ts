export type ProjectSummary = {
  projectIdentityKey: string;
  canonicalProjectIdentityKey: string;
  displayName: string;
  confidence: string;
  sessionCount: number;
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

export type ListEnvelope<T> = {
  items: T[];
  isDone: boolean;
  continueCursor: string;
};

export type PageInfo = {
  isDone: boolean;
  continueCursor: string;
};

export type SessionBrowseFilters = {
  projectIdentityKey: string;
  provider: string;
  agentName: string;
  machineId: string;
};

export type DashboardData = {
  projects: ProjectSummary[];
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
  pagination?: {
    events?: PageInfo;
    contentBlocks?: PageInfo;
    sessionEdges?: PageInfo;
    toolCalls?: PageInfo;
    usageRecords?: PageInfo;
    artifacts?: PageInfo;
  };
  views?: {
    chronological?: unknown[];
    branch?: Array<{ eventId: string }>;
    toolExpanded?: unknown[];
    selected?: string;
  };
};

export type SearchMode = "text" | "semantic" | "fusion";
