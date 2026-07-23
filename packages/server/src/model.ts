import type { Provider } from "./provider";

export type MessageRole = "user" | "assistant" | "reasoning";

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
  readonly rawPath?: string;
}

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

export interface SessionRow {
  readonly sessionId: string;
  readonly projectKey: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly title?: string;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly sourcePath: string;
  readonly sourceFingerprint: string;
  readonly host: string;
  readonly identitySchemeVersion: number;
  readonly normalizationVersion: number;
  /** Latest observed execution model, projected for cheap list/filter access. */
  readonly model?: string;
  readonly modelProvider?: string;
  /** Assignment role only; the complete assignment is returned by session detail. */
  readonly assignmentRole?: string;
  /** Canonical Quasar SessionId of the parent session when this session is a
   * subagent/child, recovered from a `kind="subagent_of"` SessionEdge — the
   * single canonical source of this column. (Never `kind="parent"`, which is
   * event-to-event message threading and may carry a raw message uuid on
   * `fromId`.) Absent for root sessions. The one persisted-and-served parent
   * lineage. */
  readonly parentSessionId?: string;
  readonly messageCount: number;
  readonly toolCallCount: number;
}

export interface MessageRow {
  readonly sessionId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly text: string;
  readonly ts?: string;
  readonly projectKey: string;
  readonly contentHash: string;
}

export interface ToolCallRow {
  readonly id: string;
  readonly sessionId: string;
  readonly eventId?: string;
  readonly seq: number;
  readonly toolName: string;
  readonly status?: string;
  readonly inputText: string;
  readonly outputText: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly projectKey: string;
  readonly provider: Provider;
}

export interface AgentAssignment {
  readonly nickname?: string;
  readonly role?: string;
  readonly path?: string;
  readonly depth?: number;
}

export type SessionEventKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "reasoning"
  | "preamble"
  | "system"
  | "summary"
  | "edit"
  | "snapshot"
  | "lifecycle"
  | "usage"
  | "unknown";

export type SessionRole =
  | "user"
  | "assistant"
  | "developer"
  | "system"
  | "tool"
  | "thinking"
  | "unknown";

export type ContentBlockKind = "text" | "markdown" | "thinking" | "image" | "file" | "json";

export interface ContentBlockRow {
  readonly id: string;
  readonly sequence: number;
  readonly kind: ContentBlockKind;
  readonly text?: string;
  readonly markdown?: string;
  readonly thinking?: string;
  readonly path?: string;
  readonly uri?: string;
  readonly mediaType?: string;
  readonly value?: unknown;
  readonly metadata?: unknown;
}

export interface RawReferenceRow {
  readonly sourcePath: string;
  readonly line?: number;
  readonly table?: string;
  readonly rowId?: string;
  readonly nativeType?: string;
  readonly rawBytes?: number;
}

export interface SessionEventRow {
  readonly id: string;
  readonly sessionId: string;
  readonly nativeEventId?: string;
  readonly sequence: number;
  readonly timestamp?: string;
  readonly machineId: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly role: SessionRole;
  readonly kind: SessionEventKind;
  readonly contentText?: string;
  readonly contentBlocks: readonly ContentBlockRow[];
  readonly toolCallId?: string;
  readonly parentEventId?: string;
  readonly rawReference: RawReferenceRow;
}

export type SessionEdgeKind =
  | "next"
  | "parent"
  | "tool_result_for"
  | "forked_from"
  | "subagent_of"
  | "compacted_into"
  | "artifact_of";

export interface SessionEdgeRow {
  readonly id: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly kind: SessionEdgeKind;
  readonly fromEventId?: string;
  readonly toEventId?: string;
  readonly fromId?: string;
  readonly toId?: string;
  readonly rawReference?: unknown;
  readonly metadata?: unknown;
}

export interface UsageRecordRow {
  readonly id: string;
  readonly sessionId: string;
  readonly eventId?: string;
  readonly machineId: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly timestamp?: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly cacheReadInputTokens?: number;
  readonly totalTokens?: number;
  readonly cost?: number;
  readonly currency?: string;
}

export interface ArtifactRow {
  readonly id: string;
  readonly sessionId: string;
  readonly eventId?: string;
  readonly machineId: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly kind: string;
  readonly path?: string;
  readonly uri?: string;
  readonly contentHash?: string;
  readonly sourcePath?: string;
  readonly sourceRef?: unknown;
  readonly metadata?: unknown;
}

export type ExecutionContextScope = "session" | "turn";

export interface ExecutionContextRow {
  readonly id: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly scope: ExecutionContextScope;
  readonly timestamp?: string;
  readonly turnId?: string;
  readonly machineId: string;
  readonly provider: Provider;
  readonly agentName: string;
  readonly projectIdentityKey: string;
  readonly model?: string;
  readonly modelProvider?: string;
  readonly reasoningEffort?: string;
  readonly serviceTier?: string;
  readonly approvalPolicy?: string;
  readonly collaborationMode?: string;
  readonly multiAgentMode?: string;
  readonly personality?: string;
  readonly permissionProfileType?: string;
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

export interface MappedSession {
  readonly project: ProjectRow;
  readonly session: SessionRow;
  readonly messages: readonly MessageRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly events: readonly SessionEventRow[];
  readonly usageRecords: readonly UsageRecordRow[];
  readonly sessionEdges: readonly SessionEdgeRow[];
  readonly artifacts: readonly ArtifactRow[];
  readonly executionContexts: readonly ExecutionContextRow[];
  readonly assignment?: AgentAssignment;
}
