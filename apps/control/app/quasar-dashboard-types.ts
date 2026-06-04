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
  }>;
  toolCalls: Array<{
    toolCallId: string;
    toolName: string;
    status?: string;
    eventId: string;
  }>;
};

export type SearchMode = "text" | "semantic" | "fusion";
