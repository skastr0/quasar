import type { Provider } from "@skastr0/quasar-core";

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
}
