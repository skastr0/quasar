import type { Provider, SessionEventKind, SessionRole, ToolCall, UsageRecord } from "../schemas";
import {
  kindFromNative,
  numberValue,
  projectSessionNativeValue,
  projectToolPayloadNativeValue,
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
  projectSessionNativeValue(contentCandidateFromRecord(record));

export const toolNameFromRecord = (value: unknown) => {
  const record = recordFrom(value);
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
  value: unknown,
  fallbackKey: unknown,
): ToolCallDraft | undefined => {
  const record = recordFrom(value);
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
  const input = projectToolPayloadNativeValue(
    state.input ?? record.input ?? record.args ?? record.arguments ?? record.params,
  );
  const output = projectToolPayloadNativeValue(
    state.output ?? record.output ?? record.result ?? record.response,
  );
  return {
    id: scopedId(provider, machineId, sourcePath, "tool", nativeSessionId, nativeToolId),
    eventId,
    toolName,
    status,
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
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
  value: unknown,
  modelProvider: string | undefined,
): UsageRecordDraft | undefined => {
  const record = recordFrom(value);
  const usage = usagePayloadFromRecord(record);
  const usageIsWholeRecord = usage === record;
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
  const cost = numberValue(usage.cost) ?? (usageIsWholeRecord ? numberValue(record.cost) : undefined);
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

const usagePayloadFromRecord = (record: Record<string, unknown>) => {
  if (
    record.usage !== undefined ||
    record.tokens !== undefined ||
    record.metrics !== undefined
  ) {
    return firstRecord(record.usage, record.tokens, record.metrics);
  }
  const type = String(record.type ?? record.kind ?? record.event ?? "").toLowerCase();
  if (/(^|[_:-])(usage|token|cost|metrics?)([_:-]|$)/i.test(type)) return record;
  return {};
};

export const bestEffortEventRecordLike = (value: unknown) => {
  const record = recordFrom(value);
  return (
    recordHasContentSignal(record) ||
    recordHasToolSignal(record) ||
    recordHasUsageSignal(record) ||
    recordHasKnownEventType(record)
  );
};

const recordLooksToolLike = (record: Record<string, unknown>) => {
  const type = String(record.type ?? record.kind ?? record.event ?? "").toLowerCase();
  const state = recordFrom(record.state);
  return (
    type.includes("tool") ||
    type.includes("bash") ||
    type.includes("command") ||
    stringValue(record.toolName) !== undefined ||
    stringValue(record.tool_call_id) !== undefined ||
    stringValue(record.toolCallId) !== undefined ||
    stringValue(record.tool_use_id) !== undefined ||
    stringValue(record.callId) !== undefined ||
    stringValue(record.callID) !== undefined ||
    stringValue(record.command) !== undefined ||
    stringValue(recordFrom(record.function).name) !== undefined ||
    stringValue(state.tool) !== undefined ||
    stringValue(state.name) !== undefined
  );
};

const contentCandidateFromRecord = (record: Record<string, unknown>) => {
  const message = recordFrom(record.message);
  return (
    record.content ??
    record.text ??
    (typeof record.message === "string" ? record.message : undefined) ??
    message.content ??
    message.text ??
    message.parts ??
    message.delta ??
    record.parts ??
    record.delta
  );
};

const recordHasContentSignal = (record: Record<string, unknown>) =>
  contentValueLike(contentCandidateFromRecord(record));

const contentValueLike = (value: unknown): boolean => {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.some(contentValueLike);
  if (value === null || typeof value !== "object") return false;
  const record = recordFrom(value);
  return (
    contentValueLike(record.text) ||
    contentValueLike(record.content) ||
    contentValueLike(record.message) ||
    contentValueLike(record.parts) ||
    contentValueLike(record.delta) ||
    contentValueLike(record.patch) ||
    contentValueLike(record.diff)
  );
};

const recordHasToolSignal = (record: Record<string, unknown>) =>
  toolNameFromRecord(record) !== undefined;

const recordHasUsageSignal = (record: Record<string, unknown>) => {
  const usage = usagePayloadFromRecord(record);
  return [
    usage.input_tokens,
    usage.inputTokens,
    usage.prompt_tokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.completion_tokens,
    usage.reasoning_tokens,
    usage.reasoningTokens,
    usage.total_tokens,
    usage.totalTokens,
    usage.total,
    usage.cost,
    record.cost,
  ].some((value) => numberValue(value) !== undefined);
};

const recordHasKnownEventType = (record: Record<string, unknown>) => {
  const type = String(record.type ?? record.kind ?? record.event ?? "").toLowerCase();
  if (/(^|[_:-])delta([_:-]|$)/i.test(type)) {
    return contentValueLike(record.delta) || contentValueLike(record.content) || contentValueLike(record.text);
  }
  if (/(^|[_:-])(usage|token|cost|metrics?)([_:-]|$)/i.test(type)) {
    return recordHasUsageSignal(record);
  }
  return /(^|[_:-])(user|assistant|system|developer|message|reasoning|thinking|tool|bash|command)([_:-]|$)/i.test(type);
};

const sumNumbers = (values: readonly (number | undefined)[]) => {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((sum, value) => sum + value, 0);
};
