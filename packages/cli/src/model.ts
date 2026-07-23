import type {
  AgentAssignment,
  Artifact,
  ExecutionContextRecord,
  Provider,
  SessionEdge,
  SessionEvent,
  UsageRecord,
} from "./core/schemas";

export type MessageRole = "user" | "assistant" | "reasoning";

export interface ProjectRow {
  readonly projectKey: string;
  readonly displayName: string;
  readonly rawPath?: string;
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

export interface MappedSession {
  readonly project: ProjectRow;
  readonly session: SessionRow;
  readonly messages: readonly MessageRow[];
  readonly toolCalls: readonly ToolCallRow[];
  readonly events: readonly SessionEvent[];
  readonly usageRecords: readonly UsageRecord[];
  readonly sessionEdges: readonly SessionEdge[];
  readonly artifacts: readonly Artifact[];
  readonly executionContexts: readonly ExecutionContextRecord[];
  readonly assignment?: AgentAssignment;
}
