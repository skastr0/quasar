import type {
  AgentAssignment as ProtocolAgentAssignment,
  Artifact as ProtocolArtifact,
  ExecutionContextRecord as ProtocolExecutionContext,
  MappedSession as ProtocolMappedSession,
  MessageRole,
  MessageRow as ProtocolMessageRow,
  ProjectRow as ProtocolProjectRow,
  SessionEdge as ProtocolSessionEdge,
  SessionEvent as ProtocolSessionEvent,
  SessionRow as ProtocolSessionRow,
  ToolCallRow as ProtocolToolCallRow,
  UsageRecord as ProtocolUsageRecord,
} from "@skastr0/quasar-protocol";

import type { Provider } from "./provider";

export type AgentAssignment = ProtocolAgentAssignment;
export type ArtifactRow = ProtocolArtifact;
export type ExecutionContextRow = ProtocolExecutionContext;
export type MappedSession = ProtocolMappedSession;
export type MessageRow = ProtocolMessageRow;
export type ProjectRow = ProtocolProjectRow;
export type SessionEdgeRow = ProtocolSessionEdge;
export type SessionEventRow = ProtocolSessionEvent;
export type SessionRow = ProtocolSessionRow;
export type ToolCallRow = ProtocolToolCallRow;
export type UsageRecordRow = ProtocolUsageRecord;

export type IngestRunStatus = "running" | "completed" | "failed";

export interface IngestRunRow {
  readonly runId: string;
  readonly provider: Provider | "all";
  readonly status: IngestRunStatus;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly sessionsSeen: number;
  readonly sessionsWritten: number;
  readonly sessionsSkipped: number;
  readonly sessionsFailed: number;
}

export type QueueJobStatus = "pending" | "leased" | "completed" | "failed";

export interface QueueJobRow {
  readonly jobId: string;
  readonly kind: string;
  readonly payload: unknown;
  readonly status: QueueJobStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly leasedBy?: string;
  readonly leaseUntil?: string;
  readonly nextRunAt: string;
  readonly lastError?: string;
  readonly idempotencyKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Complete relational shape used by the QuerySpec adapter. Fields that may
 * be absent in provider data stay explicit `null` so projection can preserve
 * the requested key set exactly. */
export interface QuerySessionRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: Provider;
  readonly title: string | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly agentName: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly parentSessionId: string | null;
  readonly agentRole: string | null;
  readonly agentPath: string | null;
  readonly agentDepth: number | null;
  readonly sourcePath: string;
  readonly sourceFingerprint: string;
  readonly host: string;
  readonly identitySchemeVersion: number;
  readonly normalizationVersion: number;
}

export interface QueryMessageRow {
  readonly messageId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly timestamp: string | null;
  readonly projectKey: string;
  readonly provider: Provider;
  readonly title: string | null;
  readonly agentName: string | null;
  readonly agentRole: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly executionContextId: string | null;
  readonly reasoningEffort: string | null;
}

export interface QueryToolCallRow {
  readonly toolCallId: string;
  readonly eventId: string;
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: Provider;
  readonly sequence: number;
  readonly toolName: string;
  readonly timestamp: string | null;
  readonly status: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly agentName: string | null;
  readonly agentRole: string | null;
  readonly model: string | null;
  readonly modelProvider: string | null;
  readonly executionContextId: string | null;
  readonly reasoningEffort: string | null;
  readonly inputText?: string;
  readonly outputText?: string;
}

export interface PageWindow {
  readonly limit: number;
  readonly offset: number;
}

export interface Page<T> extends PageWindow {
  readonly total: number;
  readonly hasMore: boolean;
  readonly rows: readonly T[];
}

export interface SessionDetailPageOptions {
  readonly messages: PageWindow;
  readonly toolCalls: PageWindow;
  readonly events: PageWindow;
  readonly usageRecords: PageWindow;
  readonly sessionEdges: PageWindow;
  readonly artifacts: PageWindow;
  readonly executionContexts: PageWindow;
}

export interface SessionDetail {
  readonly session: SessionRow;
  readonly assignment?: AgentAssignment;
  readonly messages: Page<MessageRow>;
  readonly toolCalls: Page<ToolCallRow>;
  readonly events: Page<SessionEventRow>;
  readonly usageRecords: Page<UsageRecordRow>;
  readonly sessionEdges: Page<SessionEdgeRow>;
  readonly artifacts: Page<ArtifactRow>;
  readonly executionContexts: Page<ExecutionContextRow>;
}
