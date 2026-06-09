import type { Provider, SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../schemas";
import {
  kindFromNative,
  numberValue,
  recordFrom,
  roleFrom,
  scopedId,
  stringValue,
  usageIdFor,
} from "./common";

export type ToolCallDraft = Omit<
  ToolCall,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;
export type UsageRecordDraft = Omit<
  UsageRecord,
  "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
>;

export const timestampFromRecord = (record: Record<string, unknown>) => {
  const candidate =
    stringValue(record.timestamp) ??
    stringValue(record.createdAt) ??
    stringValue(record.updatedAt) ??
    stringValue(record.time) ??
    stringValue(record.ts);
  if (candidate !== undefined) return candidate;
  const numeric =
    numberValue(record.timestamp) ??
    numberValue(record.createdAt) ??
    numberValue(record.updatedAt) ??
    numberValue(record.ts);
  if (numeric === undefined) return undefined;
  return new Date(numeric > 10_000_000_000 ? numeric : numeric * 1000).toISOString();
};

export const nativeIdFromRecord = (record: Record<string, unknown>, fallback: unknown) =>
  stringValue(record.id) ??
  stringValue(record.uuid) ??
  stringValue(record.messageId) ??
  stringValue(record.eventId) ??
  String(fallback);

export const roleFromRecord = (record: Record<string, unknown>): SessionRole => {
  const message = recordFrom(record.message);
  return roleFrom(
    stringValue(record.role) ??
      stringValue(message.role) ??
      stringValue(record.type) ??
      stringValue(record.kind),
  );
};

export const kindFromRecord = (record: Record<string, unknown>): SessionEventKind => {
  const type = (
    stringValue(record.type) ??
    stringValue(record.kind) ??
    stringValue(record.event) ??
    "unknown"
  ).toLowerCase();
  if (toolNameFromRecord(record) !== undefined) {
    const status = String(recordFrom(record.state).status ?? record.status ?? "").toLowerCase();
    return status === "completed" || status === "success" || type.includes("result")
      ? "tool_result"
      : "tool_call";
  }
  return kindFromNative(type);
};

export const contentFromRecord = (record: Record<string, unknown>) =>
  record.content ??
  record.text ??
  record.message ??
  record.parts ??
  record.delta;

export const toolNameFromRecord = (record: Record<string, unknown>) => {
  if (stringValue(record.toolName) !== undefined) return stringValue(record.toolName);
  if (stringValue(record.tool) !== undefined) return stringValue(record.tool);
  if (stringValue(record.name) !== undefined && recordLooksToolLike(record)) {
    return stringValue(record.name);
  }
  const functionRecord = recordFrom(record.function);
  if (stringValue(functionRecord.name) !== undefined) return stringValue(functionRecord.name);
  const state = recordFrom(record.state);
  if (stringValue(state.tool) !== undefined) return stringValue(state.tool);
  if (stringValue(state.name) !== undefined) return stringValue(state.name);
  if (recordLooksToolLike(record) && stringValue(record.command) !== undefined) return "bash";
  return undefined;
};

export const bestEffortToolCall = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
  eventId: string,
  record: Record<string, unknown>,
  fallbackKey: unknown,
): ToolCallDraft | undefined => {
  const toolName = toolNameFromRecord(record);
  if (toolName === undefined) return undefined;
  const state = recordFrom(record.state);
  const nativeToolId =
    stringValue(record.callId) ??
    stringValue(record.callID) ??
    stringValue(record.call_id) ??
    stringValue(record.toolCallId) ??
    stringValue(record.tool_use_id) ??
    stringValue(record.id) ??
    String(fallbackKey);
  const status =
    stringValue(state.status) ??
    stringValue(record.status) ??
    (kindFromRecord(record) === "tool_result" ? "completed" : undefined);
  const timestamp = timestampFromRecord(record);
  return {
    id: scopedId(provider, machineId, sourcePath, "tool", nativeSessionId, nativeToolId),
    eventId,
    toolName,
    status,
    input: state.input ?? record.input ?? record.args ?? record.arguments ?? record.params,
    output: state.output ?? record.output ?? record.result ?? record.response,
    ...(timestamp !== undefined ? { startedAt: timestamp } : {}),
    ...(status === "completed" && timestamp !== undefined ? { completedAt: timestamp } : {}),
  };
};

export const usageFromRecord = (
  provider: Provider,
  machineId: string,
  sourcePath: string,
  nativeSessionId: string,
  eventId: string,
  sequence: number,
  record: Record<string, unknown>,
  modelProvider: string | undefined,
): UsageRecordDraft | undefined => {
  const usage = firstRecord(record.usage, record.tokens, record.metrics, record);
  const inputTokens =
    numberValue(usage.input_tokens) ??
    numberValue(usage.inputTokens) ??
    numberValue(usage.input) ??
    numberValue(usage.prompt_tokens);
  const outputTokens =
    numberValue(usage.output_tokens) ??
    numberValue(usage.outputTokens) ??
    numberValue(usage.output) ??
    numberValue(usage.completion_tokens);
  const reasoningTokens =
    numberValue(usage.reasoning_tokens) ?? numberValue(usage.reasoningTokens) ?? numberValue(usage.reasoning);
  const cache = recordFrom(usage.cache);
  const cacheCreationInputTokens =
    numberValue(usage.cache_creation_input_tokens) ??
    numberValue(usage.cacheCreationInputTokens) ??
    numberValue(cache.write);
  const cacheReadInputTokens =
    numberValue(usage.cache_read_input_tokens) ??
    numberValue(usage.cacheReadInputTokens) ??
    numberValue(cache.read);
  const totalTokens =
    numberValue(usage.total_tokens) ??
    numberValue(usage.totalTokens) ??
    numberValue(usage.total) ??
    sumNumbers([
      inputTokens,
      outputTokens,
      reasoningTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
    ]);
  const cost = numberValue(usage.cost) ?? numberValue(record.cost);
  if (totalTokens === undefined && cost === undefined) return undefined;
  return {
    id: usageIdFor(provider, machineId, sourcePath, nativeSessionId, eventId, sequence),
    eventId,
    timestamp: timestampFromRecord(record),
    model:
      stringValue(record.model) ??
      stringValue(record.modelID) ??
      stringValue(record.modelId) ??
      stringValue(usage.model),
    modelProvider:
      stringValue(record.provider) ??
      stringValue(record.providerID) ??
      stringValue(record.providerId) ??
      modelProvider,
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    totalTokens,
    cost,
    currency: stringValue(usage.currency),
  };
};

const firstRecord = (...values: unknown[]) => {
  for (const value of values) {
    const record = recordFrom(value);
    if (Object.keys(record).length > 0) return record;
  }
  return {};
};

const recordLooksToolLike = (record: Record<string, unknown>) => {
  const type = String(record.type ?? record.kind ?? record.event ?? "").toLowerCase();
  return (
    type.includes("tool") ||
    type.includes("bash") ||
    type.includes("command") ||
    record.input !== undefined ||
    record.output !== undefined ||
    record.arguments !== undefined
  );
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};
