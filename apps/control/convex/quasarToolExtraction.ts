export const extractToolName = (event: {
  readonly content?: unknown;
  readonly raw?: unknown;
  readonly kind: string;
}) => {
  const candidates = [event.content, event.raw];
  for (const candidate of candidates) {
    const name = toolNameFromRecord(candidate);
    if (name !== undefined) return name;
  }
  return event.kind === "tool_result" ? "tool_result" : "tool_call";
};

const toolNameFromRecord = (candidate: unknown) => {
  if (!candidate || typeof candidate !== "object") return undefined;
  const record = candidate as Record<string, unknown>;
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  if (typeof record.name === "string") return record.name;
  return nestedToolName(record.function ?? record.payload ?? record.data);
};

const nestedToolName = (value: unknown) => {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name === "string") return record.name;
  if (typeof record.tool === "string") return record.tool;
  return undefined;
};

export const normalizeToolCallId = (
  sessionId: string,
  event: Record<string, unknown>,
  eventId: string,
  lastToolCallByName: Map<string, string>,
) => {
  if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
    return event.toolCallId;
  }
  const toolName = extractToolName({
    kind: String(event.kind ?? ""),
    content: event.content,
    raw: event.raw,
  });
  if (event.kind === "tool_result") {
    return lastToolCallByName.get(toolName) ?? `tool:${sessionId}:${toolName}`;
  }
  const toolCallId = `tool:${eventId}`;
  lastToolCallByName.set(toolName, toolCallId);
  return toolCallId;
};

export const isToolEventKind = (kind: string) =>
  kind === "tool_call" || kind === "tool_result";
