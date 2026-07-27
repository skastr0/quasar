import { createHash } from "node:crypto";

import { Schema } from "effect";

import {
  NORMALIZED_SESSION_PROTOCOL_VERSION,
  decodeMappedSessionSync,
  mappedSessionExamples,
  type Artifact,
  type ContentBlock,
  type ExecutionContextRecord,
  type MappedSession,
  type SessionEdge,
  type SessionEvent,
  type ToolCallRow,
  type UsageRecord,
} from "./normalized-session";
import {
  TrajectoryFullReadPointer,
  TrajectoryProjectionOptions,
  type TrajectoryFullReadPointer as TrajectoryFullReadPointerType,
  type TrajectoryProjectionInput,
} from "./trajectory";

export const HARBOR_ATIF_VERSION = "ATIF-v1.7" as const;
export const HARBOR_ATIF_UPSTREAM_COMMIT =
  "7db020ba5a5ceee918351dd8fc374d4d60bad442" as const;
export const HARBOR_ATIF_REPOSITORY =
  "https://github.com/harbor-framework/harbor" as const;
export const HARBOR_ATIF_MODEL_PATH =
  "src/harbor/models/trajectories/trajectory.py" as const;
export const HARBOR_ATIF_VALIDATOR_PATH =
  "src/harbor/utils/trajectory_validator.py" as const;
export const HARBOR_ATIF_SCHEMA_ID =
  `https://github.com/harbor-framework/harbor/tree/${HARBOR_ATIF_UPSTREAM_COMMIT}/src/harbor/models/trajectories#${HARBOR_ATIF_VERSION}` as const;
export const QUASAR_ATIF_EXPORT_VERSION =
  "quasar.trajectory.atif-export/v1" as const;

const strictParseOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

const NonNegativeInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.nonNegative(),
);
const PositiveInteger = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
);

export type AtifJsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<AtifJsonValue>
  | { readonly [key: string]: AtifJsonValue };

const AtifJsonValue: Schema.Schema<AtifJsonValue> = Schema.Union(
  Schema.Null,
  Schema.Boolean,
  Schema.JsonNumber,
  Schema.String,
  Schema.Array(Schema.suspend(() => AtifJsonValue)),
  Schema.Record({
    key: Schema.String,
    value: Schema.suspend(() => AtifJsonValue),
  }),
).annotations({
  identifier: "HarborAtifJsonValue",
});

const AtifJsonObject = Schema.Record({
  key: Schema.String,
  value: AtifJsonValue,
});
type AtifJsonObject = typeof AtifJsonObject.Type;

export const AtifImageSource = Schema.Struct({
  media_type: Schema.Literal(
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ),
  path: Schema.String,
});
export type AtifImageSource = typeof AtifImageSource.Type;

export const AtifContentPart = Schema.Union(
  Schema.Struct({
    type: Schema.Literal("text"),
    text: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("image"),
    source: AtifImageSource,
  }),
);
export type AtifContentPart = typeof AtifContentPart.Type;

export const AtifContent = Schema.Union(
  Schema.String,
  Schema.Array(AtifContentPart),
);
export type AtifContent = typeof AtifContent.Type;

export const AtifAgent = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  model_name: Schema.optional(Schema.String),
  tool_definitions: Schema.optional(Schema.Array(AtifJsonObject)),
  extra: Schema.optional(AtifJsonObject),
});
export type AtifAgent = typeof AtifAgent.Type;

export const AtifMetrics = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  completion_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  cached_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  cost_usd: Schema.optional(Schema.Number),
  prompt_token_ids: Schema.optional(
    Schema.Array(Schema.Number.pipe(Schema.int())),
  ),
  completion_token_ids: Schema.optional(
    Schema.Array(Schema.Number.pipe(Schema.int())),
  ),
  logprobs: Schema.optional(Schema.Array(Schema.Number)),
  extra: Schema.optional(AtifJsonObject),
});
export type AtifMetrics = typeof AtifMetrics.Type;

export const AtifFinalMetrics = Schema.Struct({
  total_prompt_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  total_completion_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  total_cached_tokens: Schema.optional(Schema.Number.pipe(Schema.int())),
  total_cost_usd: Schema.optional(Schema.Number),
  total_steps: Schema.optional(NonNegativeInteger),
  extra: Schema.optional(AtifJsonObject),
});
export type AtifFinalMetrics = typeof AtifFinalMetrics.Type;

export const AtifSubagentTrajectoryRef = Schema.Struct({
  trajectory_id: Schema.optional(Schema.String),
  session_id: Schema.optional(Schema.String),
  trajectory_path: Schema.optional(Schema.String),
  extra: Schema.optional(AtifJsonObject),
}).pipe(
  Schema.filter(
    (reference) =>
      reference.trajectory_id !== undefined
        || reference.trajectory_path !== undefined
        || "ATIF subagent reference must set trajectory_id or trajectory_path",
  ),
);
export type AtifSubagentTrajectoryRef =
  typeof AtifSubagentTrajectoryRef.Type;

export const AtifToolCall = Schema.Struct({
  tool_call_id: Schema.String,
  function_name: Schema.String,
  arguments: AtifJsonObject,
  extra: Schema.optional(AtifJsonObject),
});
export type AtifToolCall = typeof AtifToolCall.Type;

export const AtifObservationResult = Schema.Struct({
  source_call_id: Schema.optional(Schema.String),
  content: Schema.optional(AtifContent),
  subagent_trajectory_ref: Schema.optional(
    Schema.Array(AtifSubagentTrajectoryRef),
  ),
  extra: Schema.optional(AtifJsonObject),
});
export type AtifObservationResult =
  typeof AtifObservationResult.Type;

export const AtifObservation = Schema.Struct({
  results: Schema.Array(AtifObservationResult),
});
export type AtifObservation = typeof AtifObservation.Type;

const validIsoTimestamp = (value: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})$/
    .test(value)
  && Number.isFinite(Date.parse(value.replace(",", ".")));

const AtifTimestamp = Schema.String.pipe(
  Schema.filter(validIsoTimestamp, {
    message: () => "Expected an ISO 8601 timestamp",
  }),
);

const atifStepInvariant = (step: {
  readonly source: "system" | "user" | "agent";
  readonly model_name?: string;
  readonly reasoning_effort?: string | number;
  readonly reasoning_content?: string;
  readonly tool_calls?: ReadonlyArray<AtifToolCall>;
  readonly metrics?: AtifMetrics;
  readonly llm_call_count?: number;
}): true | string => {
  if (step.source !== "agent") {
    const forbidden = [
      ["model_name", step.model_name],
      ["reasoning_effort", step.reasoning_effort],
      ["reasoning_content", step.reasoning_content],
      ["tool_calls", step.tool_calls],
      ["metrics", step.metrics],
    ] as const;
    const present = forbidden.find(([, value]) => value !== undefined);
    if (present !== undefined) {
      return `field ${present[0]} is only applicable when source is agent`;
    }
  }
  if (
    step.source === "agent"
    && step.llm_call_count === 0
    && (step.metrics !== undefined || step.reasoning_content !== undefined)
  ) {
    return "metrics and reasoning_content must be absent when llm_call_count is 0";
  }
  return true;
};

export const AtifStep = Schema.Struct({
  step_id: PositiveInteger,
  timestamp: Schema.optional(AtifTimestamp),
  source: Schema.Literal("system", "user", "agent"),
  model_name: Schema.optional(Schema.String),
  reasoning_effort: Schema.optional(Schema.Union(Schema.String, Schema.Number)),
  message: AtifContent,
  reasoning_content: Schema.optional(Schema.String),
  tool_calls: Schema.optional(Schema.Array(AtifToolCall)),
  observation: Schema.optional(AtifObservation),
  metrics: Schema.optional(AtifMetrics),
  is_copied_context: Schema.optional(Schema.Boolean),
  llm_call_count: Schema.optional(NonNegativeInteger),
  extra: Schema.optional(AtifJsonObject),
}).pipe(
  Schema.filter(atifStepInvariant),
);
export type AtifStep = typeof AtifStep.Type;

export interface AtifTrajectoryValue {
  readonly schema_version: typeof HARBOR_ATIF_VERSION;
  readonly session_id?: string;
  readonly trajectory_id?: string;
  readonly agent: AtifAgent;
  readonly steps: ReadonlyArray<AtifStep>;
  readonly notes?: string;
  readonly final_metrics?: AtifFinalMetrics;
  readonly continued_trajectory_ref?: string;
  readonly extra?: AtifJsonObject;
  readonly subagent_trajectories?: ReadonlyArray<AtifTrajectoryValue>;
}

const atifTrajectoryInvariant = (
  trajectory: AtifTrajectoryValue,
): true | string => {
  if (trajectory.steps.length === 0) {
    return "ATIF trajectory must contain at least one step";
  }
  for (const [index, step] of trajectory.steps.entries()) {
    if (step.step_id !== index + 1) {
      return `steps[${index}].step_id must equal ${index + 1}`;
    }
    const callIds = new Set(
      (step.tool_calls ?? []).map((toolCall) => toolCall.tool_call_id),
    );
    for (const result of step.observation?.results ?? []) {
      if (
        result.source_call_id !== undefined
        && !callIds.has(result.source_call_id)
      ) {
        return `step ${step.step_id} observation references missing tool call ${result.source_call_id}`;
      }
    }
  }
  const childIds = new Set<string>();
  for (
    const [index, child] of (trajectory.subagent_trajectories ?? []).entries()
  ) {
    if (child.trajectory_id === undefined) {
      return `subagent_trajectories[${index}].trajectory_id is required`;
    }
    if (childIds.has(child.trajectory_id)) {
      return `duplicate embedded subagent trajectory_id ${child.trajectory_id}`;
    }
    childIds.add(child.trajectory_id);
  }
  for (const step of trajectory.steps) {
    for (const result of step.observation?.results ?? []) {
      for (const reference of result.subagent_trajectory_ref ?? []) {
        if (
          reference.trajectory_id !== undefined
          && reference.trajectory_path === undefined
          && !childIds.has(reference.trajectory_id)
        ) {
          return `subagent reference ${reference.trajectory_id} does not resolve to an embedded trajectory`;
        }
      }
    }
  }
  return true;
};

export const AtifTrajectory: Schema.Schema<AtifTrajectoryValue> =
  Schema.suspend(() =>
    Schema.Struct({
      schema_version: Schema.Literal(HARBOR_ATIF_VERSION),
      session_id: Schema.optional(Schema.String),
      trajectory_id: Schema.optional(Schema.String),
      agent: AtifAgent,
      steps: Schema.Array(AtifStep).pipe(Schema.minItems(1)),
      notes: Schema.optional(Schema.String),
      final_metrics: Schema.optional(AtifFinalMetrics),
      continued_trajectory_ref: Schema.optional(Schema.String),
      extra: Schema.optional(AtifJsonObject),
      subagent_trajectories: Schema.optional(
        Schema.Array(AtifTrajectory),
      ),
    }).pipe(
      Schema.filter(atifTrajectoryInvariant),
    )
  ).annotations({
    identifier: "HarborAtifV17",
    title: "Harbor ATIF v1.7",
    description:
      "Strict ATIF-v1.7 output contract pinned to Harbor's Pydantic model and semantic validator.",
    parseOptions: strictParseOptions,
  });

export const decodeAtifTrajectorySync = Schema.decodeUnknownSync(
  AtifTrajectory,
  strictParseOptions,
);

export const AtifCompatibilityStatus = Schema.Literal(
  "mapped_core",
  "mapped_extension",
  "omitted_by_policy",
  "unobserved_atif_field",
  "projection_adjustment",
);
export type AtifCompatibilityStatus =
  typeof AtifCompatibilityStatus.Type;

export const AtifSourceFactKind = Schema.Literal(
  "session",
  "event",
  "content_block",
  "tool_call",
  "tool_result",
  "usage_record",
  "session_edge",
  "artifact",
  "execution_context",
  "atif_field",
);
export type AtifSourceFactKind = typeof AtifSourceFactKind.Type;

export const AtifCompatibilityEntry = Schema.Struct({
  id: Schema.String,
  status: AtifCompatibilityStatus,
  sourceKind: AtifSourceFactKind,
  sourceId: Schema.optional(Schema.String),
  targetPath: Schema.optional(Schema.String),
  detail: Schema.String,
  fullRead: Schema.optional(TrajectoryFullReadPointer),
});
export type AtifCompatibilityEntry =
  typeof AtifCompatibilityEntry.Type;

const AtifValidationCheck = Schema.Literal(
  "strict_fields",
  "source_specific_fields",
  "iso_timestamps",
  "sequential_step_ids",
  "tool_result_references",
  "subagent_reference_resolution",
  "embedded_subagent_ids",
);

const AtifCompatibilityCounts = Schema.Struct({
  sourceSessions: PositiveInteger,
  sourceEvents: NonNegativeInteger,
  sourceToolCalls: NonNegativeInteger,
  sourceUsageRecords: NonNegativeInteger,
  sourceSessionEdges: NonNegativeInteger,
  sourceArtifacts: NonNegativeInteger,
  sourceExecutionContexts: NonNegativeInteger,
  outputSteps: PositiveInteger,
  embeddedSubagents: NonNegativeInteger,
  mappedCore: NonNegativeInteger,
  mappedExtension: NonNegativeInteger,
  omittedByPolicy: NonNegativeInteger,
  unobservedAtifFields: NonNegativeInteger,
  projectionAdjustments: NonNegativeInteger,
});
export type AtifCompatibilityCounts =
  typeof AtifCompatibilityCounts.Type;

const atifExportInvariant = (value: {
  readonly compatibility: {
    readonly entries: ReadonlyArray<AtifCompatibilityEntry>;
    readonly counts: AtifCompatibilityCounts;
  };
}): true | string => {
  const { entries, counts } = value.compatibility;
  const expected = {
    mapped_core: counts.mappedCore,
    mapped_extension: counts.mappedExtension,
    omitted_by_policy: counts.omittedByPolicy,
    unobserved_atif_field: counts.unobservedAtifFields,
    projection_adjustment: counts.projectionAdjustments,
  } as const;
  for (const [status, count] of Object.entries(expected)) {
    if (entries.filter((entry) => entry.status === status).length !== count) {
      return `compatibility count mismatch for ${status}`;
    }
  }
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) return `duplicate compatibility entry ${entry.id}`;
    ids.add(entry.id);
  }
  return true;
};

export const AtifTrajectoryExport = Schema.Struct({
  format: Schema.Literal(QUASAR_ATIF_EXPORT_VERSION),
  schemaVersion: Schema.Literal(HARBOR_ATIF_VERSION),
  schemaId: Schema.Literal(HARBOR_ATIF_SCHEMA_ID),
  sourceProtocolVersion: Schema.Literal(
    NORMALIZED_SESSION_PROTOCOL_VERSION,
  ),
  schemaSource: Schema.Struct({
    repository: Schema.Literal(HARBOR_ATIF_REPOSITORY),
    commit: Schema.Literal(HARBOR_ATIF_UPSTREAM_COMMIT),
    modelPath: Schema.Literal(HARBOR_ATIF_MODEL_PATH),
    validatorPath: Schema.Literal(HARBOR_ATIF_VALIDATOR_PATH),
  }),
  trajectory: AtifTrajectory,
  compatibility: Schema.Struct({
    valid: Schema.Literal(true),
    validator: Schema.Literal("quasar.atif-v1.7-mirror"),
    checks: Schema.Array(AtifValidationCheck),
    entries: Schema.Array(AtifCompatibilityEntry),
    counts: AtifCompatibilityCounts,
  }),
}).pipe(
  Schema.filter(atifExportInvariant),
).annotations({
  identifier: "QuasarAtifExportV1",
  title: "Quasar Harbor ATIF export v1",
  description:
    "ATIF-v1.7 trajectory plus a fact-level compatibility and validation report.",
  parseOptions: strictParseOptions,
});
export type AtifTrajectoryExport =
  typeof AtifTrajectoryExport.Type;

export interface AtifProjectionInput extends TrajectoryProjectionInput {
  readonly subagentSessions?: ReadonlyArray<MappedSession>;
}

interface ProjectedAtif {
  readonly trajectory: AtifTrajectoryValue;
  readonly entries: AtifCompatibilityEntry[];
}

const sessionPointer = (
  sessionId: string,
  eventId?: string,
): TrajectoryFullReadPointerType => ({
  resource: "session-detail",
  sessionId,
  ...(eventId !== undefined ? { eventId } : {}),
});

const toolPointer = (
  sessionId: string,
  toolCallId: string,
  eventId?: string,
): TrajectoryFullReadPointerType => ({
  resource: "tool-call",
  sessionId,
  toolCallId,
  ...(eventId !== undefined ? { eventId } : {}),
});

const compatibilityId = (
  status: AtifCompatibilityStatus,
  sourceKind: AtifSourceFactKind,
  sourceId: string | undefined,
  targetPath: string | undefined,
): string =>
  [
    "atif",
    status,
    sourceKind,
    encodeURIComponent(sourceId ?? "none"),
    encodeURIComponent(targetPath ?? "none"),
  ].join(":");

const compatibilityEntry = (
  status: AtifCompatibilityStatus,
  sourceKind: AtifSourceFactKind,
  detail: string,
  options: {
    readonly sourceId?: string;
    readonly targetPath?: string;
    readonly fullRead?: TrajectoryFullReadPointerType;
  } = {},
): AtifCompatibilityEntry => ({
  id: compatibilityId(
    status,
    sourceKind,
    options.sourceId,
    options.targetPath,
  ),
  status,
  sourceKind,
  detail,
  ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
  ...(options.targetPath !== undefined
    ? { targetPath: options.targetPath }
    : {}),
  ...(options.fullRead !== undefined ? { fullRead: options.fullRead } : {}),
});

const toJsonValue = (
  input: unknown,
  seen = new WeakSet<object>(),
): AtifJsonValue | undefined => {
  if (
    input === null
    || typeof input === "string"
    || typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : undefined;
  }
  if (Array.isArray(input)) {
    if (seen.has(input)) return undefined;
    seen.add(input);
    const result: AtifJsonValue[] = [];
    for (const item of input) {
      const converted = toJsonValue(item, seen);
      if (converted === undefined) return undefined;
      result.push(converted);
    }
    seen.delete(input);
    return result;
  }
  if (typeof input !== "object" || input === null) return undefined;
  if (seen.has(input)) return undefined;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  seen.add(input);
  const result: Record<string, AtifJsonValue> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    const converted = toJsonValue(value, seen);
    if (converted === undefined) return undefined;
    result[key] = converted;
  }
  seen.delete(input);
  return result;
};

const jsonObject = (input: unknown): AtifJsonObject | undefined => {
  const converted = toJsonValue(input);
  return converted !== undefined
      && typeof converted === "object"
      && converted !== null
      && !Array.isArray(converted)
    ? converted as AtifJsonObject
    : undefined;
};

const normalizedOptions = (
  input: TrajectoryProjectionInput,
): TrajectoryProjectionOptions =>
  Schema.decodeUnknownSync(
    TrajectoryProjectionOptions,
    strictParseOptions,
  )({
    includeReasoning: input.includeReasoning ?? true,
    includeToolResults: input.includeToolResults ?? true,
    ...(input.toolResultMaxBytes !== undefined
      ? { toolResultMaxBytes: input.toolResultMaxBytes }
      : {}),
  });

const nonEmpty = (value: string | undefined): string | undefined =>
  value !== undefined && value.trim().length > 0 ? value : undefined;

const blockText = (block: ContentBlock): string | undefined =>
  nonEmpty(block.thinking)
  ?? nonEmpty(block.text)
  ?? nonEmpty(block.markdown);

const visibleEventText = (event: SessionEvent): string | undefined => {
  const direct = nonEmpty(event.contentText);
  if (direct !== undefined) return direct;
  const text = event.contentBlocks
    .filter((block) => block.kind === "text" || block.kind === "markdown")
    .flatMap((block) => blockText(block) ?? [])
    .join("\n\n");
  return nonEmpty(text);
};

const reasoningEventText = (event: SessionEvent): string | undefined => {
  if (event.kind === "reasoning" || event.role === "thinking") {
    return visibleEventText(event);
  }
  return nonEmpty(
    event.contentBlocks
      .filter((block) => block.kind === "thinking")
      .flatMap((block) => blockText(block) ?? [])
      .join("\n\n"),
  );
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const utf8PrefixAtMost = (text: string, maximumBytes: number): string => {
  let bytes = 0;
  let end = 0;
  for (const codePoint of text) {
    const codePointBytes = Buffer.byteLength(codePoint);
    if (bytes + codePointBytes > maximumBytes) break;
    bytes += codePointBytes;
    end += codePoint.length;
  }
  return text.slice(0, end);
};

const eventSource = (
  event: SessionEvent,
  hasToolCalls: boolean,
): AtifStep["source"] => {
  if (hasToolCalls) return "agent";
  if (
    event.kind === "tool_result"
    || event.role === "tool"
    || event.role === "developer"
    || event.role === "system"
    || event.role === "unknown"
  ) {
    return "system";
  }
  if (event.role === "user") return "user";
  return "agent";
};

const supportedImageMediaType = (
  value: string | undefined,
): value is AtifImageSource["media_type"] =>
  value === "image/jpeg"
  || value === "image/png"
  || value === "image/gif"
  || value === "image/webp";

const atifMessage = (
  event: SessionEvent,
  suppressVisibleText: boolean,
): AtifContent => {
  const hasImage = event.contentBlocks.some((block) =>
    block.kind === "image"
    && (block.path !== undefined || block.uri !== undefined)
    && supportedImageMediaType(block.mediaType)
  );
  if (!hasImage) {
    return suppressVisibleText ? "" : visibleEventText(event) ?? "";
  }
  const parts: AtifContentPart[] = event.contentBlocks.flatMap<AtifContentPart>(
    (block): AtifContentPart[] => {
      if (
        !suppressVisibleText
        && (block.kind === "text" || block.kind === "markdown")
      ) {
        const text = blockText(block);
        return text === undefined ? [] : [{ type: "text" as const, text }];
      }
      const location = block.path ?? block.uri;
      if (
        block.kind === "image"
        && location !== undefined
        && supportedImageMediaType(block.mediaType)
      ) {
        return [{
          type: "image" as const,
          source: {
            media_type: block.mediaType,
            path: location,
          },
        }];
      }
      return [];
    },
  );
  if (
    !suppressVisibleText
    && !parts.some((part) => part.type === "text")
  ) {
    const direct = visibleEventText(event);
    if (direct !== undefined) {
      parts.unshift({ type: "text", text: direct });
    }
  }
  return parts;
};

const executionContextsForEvent = (
  mapped: MappedSession,
  event: SessionEvent,
): readonly ExecutionContextRecord[] =>
  mapped.executionContexts.filter((context) =>
    context.scope === "turn"
    && (
      context.turnId === event.id
      || (
        event.nativeEventId !== undefined
        && context.turnId === event.nativeEventId
      )
    )
  );

const artifactsForEvent = (
  mapped: MappedSession,
  event: SessionEvent,
): readonly Artifact[] =>
  mapped.artifacts.filter((artifact) => artifact.eventId === event.id);

const stepModel = (
  mapped: MappedSession,
  event: SessionEvent,
  toolCalls: readonly ToolCallRow[],
): {
  readonly model?: string;
  readonly reasoningEffort?: string;
} => {
  const message = mapped.messages.find((row) => row.eventId === event.id);
  const context = executionContextsForEvent(mapped, event)[0];
  const toolCall = toolCalls[0];
  const model = message?.model
    ?? toolCall?.model
    ?? context?.model
    ?? mapped.session.model;
  const reasoningEffort = message?.reasoningEffort
    ?? toolCall?.reasoningEffort
    ?? context?.reasoningEffort;
  return {
    ...(model !== undefined ? { model } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
  };
};

const parseToolArguments = (
  inputText: string,
): {
  readonly arguments: AtifJsonObject;
  readonly exactCoreMapping: boolean;
} => {
  try {
    const parsed = JSON.parse(inputText) as unknown;
    const object = jsonObject(parsed);
    if (object !== undefined) {
      return { arguments: object, exactCoreMapping: true };
    }
  } catch {
    // The raw text is preserved in ToolCall.extra below.
  }
  return { arguments: {}, exactCoreMapping: false };
};

const usageJson = (usage: UsageRecord): AtifJsonValue =>
  toJsonValue(usage) ?? {
    id: usage.id,
    representation_error: "usage record was not JSON-compatible",
  };

const usageMetrics = (
  usageRecords: readonly UsageRecord[],
): AtifMetrics | undefined => {
  if (usageRecords.length === 0) return undefined;
  if (usageRecords.length !== 1) {
    return {
      extra: {
        quasar_usage_records: usageRecords.map(usageJson),
        core_fields_omitted:
          "multiple source usage records cannot be safely aggregated",
      },
    };
  }
  const [usage] = usageRecords;
  if (usage === undefined) return undefined;
  const usd = usage.cost !== undefined
    && usage.currency?.toUpperCase() === "USD";
  const extra: Record<string, AtifJsonValue> = {
    quasar_usage_record_id: usage.id,
  };
  if (usage.reasoningTokens !== undefined) {
    extra.reasoning_tokens = usage.reasoningTokens;
  }
  if (usage.cacheCreationInputTokens !== undefined) {
    extra.cache_creation_input_tokens = usage.cacheCreationInputTokens;
  }
  if (usage.totalTokens !== undefined) {
    extra.total_tokens = usage.totalTokens;
  }
  if (usage.model !== undefined) extra.model = usage.model;
  if (usage.modelProvider !== undefined) {
    extra.model_provider = usage.modelProvider;
  }
  if (usage.cost !== undefined && !usd) {
    extra.observed_cost = usage.cost;
    if (usage.currency !== undefined) extra.observed_currency = usage.currency;
    extra.cost_usd_omitted = "source currency was not observed as USD";
  }
  return {
    ...(usage.inputTokens !== undefined
      ? { prompt_tokens: usage.inputTokens }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { completion_tokens: usage.outputTokens }
      : {}),
    ...(usage.cacheReadInputTokens !== undefined
      ? { cached_tokens: usage.cacheReadInputTokens }
      : {}),
    ...(usd ? { cost_usd: usage.cost } : {}),
    extra,
  };
};

const eventExtra = (
  mapped: MappedSession,
  event: SessionEvent,
  includeReasoning: boolean,
  includeToolResults: boolean,
): AtifJsonObject => {
  const hideContent = (
    (event.kind === "reasoning" || event.role === "thinking")
    && !includeReasoning
  ) || (
    event.kind === "tool_result" || event.role === "tool"
  );
  const contentBlocks = event.contentBlocks.map((block) => {
    const converted = jsonObject(block) ?? {
      id: block.id,
      sequence: block.sequence,
      kind: block.kind,
      representation_error: "content block was not JSON-compatible",
    };
    if (
      (
        (!includeReasoning && block.kind === "thinking")
        || event.kind === "tool_result"
        || event.role === "tool"
      )
      && typeof converted === "object"
      && converted !== null
      && !Array.isArray(converted)
    ) {
      const {
        thinking: _thinking,
        text: _text,
        markdown: _markdown,
        value: _value,
        ...safe
      } = converted;
      return safe;
    }
    return converted;
  });
  const contexts = executionContextsForEvent(mapped, event)
    .flatMap((context) => toJsonValue(context) ?? []);
  const artifacts = artifactsForEvent(mapped, event)
    .flatMap((artifact) => toJsonValue(artifact) ?? []);
  const usageRecords = mapped.usageRecords
    .filter((usage) => usage.eventId === event.id)
    .map(usageJson);
  return {
    quasar: {
      source_event_id: event.id,
      ...(event.nativeEventId !== undefined
        ? { native_event_id: event.nativeEventId }
        : {}),
      source_sequence: event.sequence,
      source_role: event.role,
      event_kind: event.kind,
      ...(event.parentEventId !== undefined
        ? { parent_event_id: event.parentEventId }
        : {}),
      ...(!hideContent && event.contentText !== undefined
        ? { source_content_text: event.contentText }
        : {}),
      ...(
          includeToolResults
          && (event.kind === "tool_result" || event.role === "tool")
          && event.contentText !== undefined
        ? {
          source_content_bytes: Buffer.byteLength(event.contentText),
          source_content_sha256: sha256(event.contentText),
        }
        : {}
      ),
      content_blocks: contentBlocks,
      raw_reference: toJsonValue(event.rawReference) ?? {},
      ...(contexts.length > 0 ? { execution_contexts: contexts } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
      ...(usageRecords.length > 0 ? { usage_records: usageRecords } : {}),
    },
  };
};

const resultEventsFor = (
  mapped: MappedSession,
  toolCall: ToolCallRow,
): readonly SessionEvent[] =>
  mapped.events.filter((event) =>
    event.id !== toolCall.eventId
    && event.toolCallId === toolCall.id
    && (event.kind === "tool_result" || event.role === "tool")
  );

const relationEdges = (
  child: MappedSession,
  parentSessionId: string,
): readonly SessionEdge[] =>
  child.sessionEdges.filter((edge) =>
    edge.kind === "subagent_of"
    && edge.fromId === parentSessionId
    && (edge.toId === undefined || edge.toId === child.session.sessionId)
  );

const projectSingleAtif = (
  mapped: MappedSession,
  path: string,
  projection: TrajectoryProjectionOptions,
  childrenByParent: ReadonlyMap<string, readonly MappedSession[]>,
  visiting: ReadonlySet<string>,
  coreMappedEdgeIds: Set<string>,
): ProjectedAtif => {
  const sessionId = mapped.session.sessionId;
  if (visiting.has(sessionId)) {
    throw new Error(`cyclic subagent relationship at session ${sessionId}`);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(sessionId);
  const children = childrenByParent.get(sessionId) ?? [];
  const childProjections = children.map((child, index) =>
    projectSingleAtif(
      child,
      `${path}.subagent_trajectories[${index}]`,
      projection,
      childrenByParent,
      nextVisiting,
      coreMappedEdgeIds,
    )
  );
  const entries: AtifCompatibilityEntry[] = childProjections.flatMap(
    (child) => child.entries,
  );
  const toolCallsByEvent = new Map<string, ToolCallRow[]>();
  for (const toolCall of mapped.toolCalls) {
    const grouped = toolCallsByEvent.get(toolCall.eventId) ?? [];
    grouped.push(toolCall);
    toolCallsByEvent.set(toolCall.eventId, grouped);
  }
  for (const grouped of toolCallsByEvent.values()) {
    grouped.sort((left, right) => left.id.localeCompare(right.id));
  }

  const steps: AtifStep[] = [];
  for (const event of mapped.events) {
    const stepPath = `${path}.steps[${steps.length}]`;
    const eventPointer = sessionPointer(sessionId, event.id);
    const toolCalls = toolCallsByEvent.get(event.id) ?? [];
    const source = eventSource(event, toolCalls.length > 0);
    const associatedResult = event.kind === "tool_result"
      || event.role === "tool";
    const reasoning = reasoningEventText(event);
    const model = stepModel(mapped, event, toolCalls);
    const usageRecords = mapped.usageRecords.filter((usage) =>
      usage.eventId === event.id
    );
    const metrics = source === "agent" ? usageMetrics(usageRecords) : undefined;
    const atifToolCalls: AtifToolCall[] = [];
    const results: AtifObservationResult[] = [];

    for (const [toolIndex, toolCall] of toolCalls.entries()) {
      const callPath = `${stepPath}.tool_calls[${toolIndex}]`;
      const parsedArguments = parseToolArguments(toolCall.inputText);
      const resultEvents = resultEventsFor(mapped, toolCall);
      const toolExtra: AtifJsonObject = {
        quasar: {
          source_event_id: toolCall.eventId,
          source_sequence: toolCall.seq,
          raw_arguments: toolCall.inputText,
          arguments_sha256: sha256(toolCall.inputText),
          ...(toolCall.status !== undefined ? { status: toolCall.status } : {}),
          ...(toolCall.startedAt !== undefined
            ? { started_at: toolCall.startedAt }
            : {}),
          ...(toolCall.completedAt !== undefined
            ? { completed_at: toolCall.completedAt }
            : {}),
          ...(!parsedArguments.exactCoreMapping
            ? { core_arguments_placeholder: "raw input was not a JSON object" }
            : {}),
        },
      };
      atifToolCalls.push({
        tool_call_id: toolCall.id,
        function_name: toolCall.toolName,
        arguments: parsedArguments.arguments,
        extra: toolExtra,
      });
      entries.push(compatibilityEntry(
        parsedArguments.exactCoreMapping ? "mapped_core" : "mapped_extension",
        "tool_call",
        parsedArguments.exactCoreMapping
          ? "Tool name, identifier, and JSON-object arguments map to ATIF core fields; exact raw input remains in ToolCall.extra."
          : "ATIF requires an arguments object; the exact non-object/raw input is preserved in ToolCall.extra while core arguments is empty.",
        {
          sourceId: toolCall.id,
          targetPath: callPath,
          fullRead: toolPointer(sessionId, toolCall.id, event.id),
        },
      ));

      const resultObserved = resultEvents.length > 0
        || toolCall.outputText !== ""
        || toolCall.completedAt !== undefined;
      if (!resultObserved) continue;
      if (!projection.includeToolResults) {
        entries.push(compatibilityEntry(
          "omitted_by_policy",
          "tool_result",
          "Tool result content was excluded by the caller; the full-read pointer remains available.",
          {
            sourceId: toolCall.id,
            fullRead: toolPointer(
              sessionId,
              toolCall.id,
              resultEvents[0]?.id ?? event.id,
            ),
          },
        ));
        continue;
      }
      const sourceContent = toolCall.outputText !== ""
        ? toolCall.outputText
        : resultEvents
          .map((resultEvent) => visibleEventText(resultEvent) ?? "")
          .join("");
      const originalBytes = Buffer.byteLength(sourceContent);
      const returned = projection.toolResultMaxBytes !== undefined
          && originalBytes > projection.toolResultMaxBytes
        ? utf8PrefixAtMost(sourceContent, projection.toolResultMaxBytes)
        : sourceContent;
      const returnedBytes = Buffer.byteLength(returned);
      const truncated = returnedBytes < originalBytes;
      const resultPath =
        `${stepPath}.observation.results[${results.length}]`;
      results.push({
        source_call_id: toolCall.id,
        content: returned,
        extra: {
          quasar: {
            source_tool_call_id: toolCall.id,
            source_event_ids: resultEvents.map((item) => item.id),
            original_bytes: originalBytes,
            returned_bytes: returnedBytes,
            content_sha256: sha256(sourceContent),
            truncated,
            full_read: toJsonValue(toolPointer(
              sessionId,
              toolCall.id,
              resultEvents[0]?.id ?? event.id,
            )) ?? {},
          },
        },
      });
      entries.push(compatibilityEntry(
        truncated ? "projection_adjustment" : "mapped_core",
        "tool_result",
        truncated
          ? `ATIF observation contains ${returnedBytes} of ${originalBytes} UTF-8 bytes; hash and full-read pointer preserve traceability.`
          : "Tool result maps to an ATIF observation result.",
        {
          sourceId: toolCall.id,
          targetPath: resultPath,
          fullRead: toolPointer(
            sessionId,
            toolCall.id,
            resultEvents[0]?.id ?? event.id,
          ),
        },
      ));
    }

    if (associatedResult && event.toolCallId === undefined) {
      if (projection.includeToolResults) {
        const resultPath =
          `${stepPath}.observation.results[${results.length}]`;
        results.push({
          content: visibleEventText(event) ?? "",
          extra: {
            quasar: {
              source_event_id: event.id,
              uncorrelated_tool_result: true,
            },
          },
        });
        entries.push(compatibilityEntry(
          "mapped_extension",
          "tool_result",
          "The source result had no tool-call correlation; ATIF preserves it as an uncorrelated observation.",
          {
            sourceId: event.id,
            targetPath: resultPath,
            fullRead: eventPointer,
          },
        ));
      } else {
        entries.push(compatibilityEntry(
          "omitted_by_policy",
          "tool_result",
          "Uncorrelated tool result content was excluded by the caller.",
          { sourceId: event.id, fullRead: eventPointer },
        ));
      }
    }

    const step: AtifStep = {
      step_id: steps.length + 1,
      source,
      message: atifMessage(
        event,
        associatedResult || event.kind === "reasoning"
          || event.role === "thinking",
      ),
      ...(validIsoTimestamp(event.timestamp ?? "")
        ? { timestamp: event.timestamp }
        : {}),
      ...(source === "agent" && model.model !== undefined
        ? { model_name: model.model }
        : {}),
      ...(source === "agent" && model.reasoningEffort !== undefined
        ? { reasoning_effort: model.reasoningEffort }
        : {}),
      ...(source === "agent"
          && projection.includeReasoning
          && reasoning !== undefined
        ? { reasoning_content: reasoning }
        : {}),
      ...(atifToolCalls.length > 0 ? { tool_calls: atifToolCalls } : {}),
      ...(results.length > 0 ? { observation: { results } } : {}),
      ...(metrics !== undefined ? { metrics } : {}),
      extra: eventExtra(
        mapped,
        event,
        projection.includeReasoning,
        projection.includeToolResults,
      ),
    };
    steps.push(step);
    entries.push(compatibilityEntry(
      associatedResult ? "mapped_extension" : "mapped_core",
      "event",
      associatedResult
        ? "ATIF fuses tool observations into the originating agent step; this source result event remains as an ordered provenance step."
        : "Source event maps to one ordered ATIF step with Quasar identity retained in Step.extra.",
      {
        sourceId: event.id,
        targetPath: stepPath,
        fullRead: eventPointer,
      },
    ));

    if (
      event.timestamp !== undefined
      && !validIsoTimestamp(event.timestamp)
    ) {
      entries.push(compatibilityEntry(
        "projection_adjustment",
        "event",
        "The observed timestamp was not valid ISO 8601, so ATIF.timestamp is absent and the original remains in Step.extra.",
        {
          sourceId: event.id,
          targetPath: `${stepPath}.extra.quasar`,
          fullRead: eventPointer,
        },
      ));
    }
    if (reasoning !== undefined && !projection.includeReasoning) {
      entries.push(compatibilityEntry(
        "omitted_by_policy",
        "event",
        "Reasoning content was excluded by the caller.",
        { sourceId: event.id, fullRead: eventPointer },
      ));
    }
    for (const block of event.contentBlocks) {
      const blockPath = `${stepPath}.extra.quasar.content_blocks[${block.sequence}]`;
      const supportedImage = block.kind === "image"
        && (block.path !== undefined || block.uri !== undefined)
        && supportedImageMediaType(block.mediaType);
      const coreMapped = block.kind === "text"
        || block.kind === "markdown"
        || (block.kind === "thinking" && projection.includeReasoning)
        || supportedImage;
      const omitted = block.kind === "thinking"
        && !projection.includeReasoning;
      entries.push(compatibilityEntry(
        omitted
          ? "omitted_by_policy"
          : coreMapped
          ? "mapped_core"
          : "mapped_extension",
        "content_block",
        omitted
          ? "Thinking block content was excluded by the caller; its identity and kind remain in Step.extra."
          : coreMapped
          ? "Content block maps to ATIF message or reasoning content and retains block identity in Step.extra."
          : "ATIF has no core field for this content-block kind; the complete block remains in Step.extra.",
        {
          sourceId: block.id,
          targetPath: blockPath,
          fullRead: eventPointer,
        },
      ));
    }
    for (const usage of usageRecords) {
      entries.push(compatibilityEntry(
        source === "agent" && usageRecords.length === 1
          ? "mapped_core"
          : "mapped_extension",
        "usage_record",
        source === "agent" && usageRecords.length === 1
          ? "Observed per-event token fields map without inference; Quasar-only usage fields remain in Metrics.extra."
          : "ATIF cannot safely attach or aggregate this usage record as step metrics; the exact record remains in an extension.",
        {
          sourceId: usage.id,
          targetPath: source === "agent"
            ? `${stepPath}.metrics`
            : `${stepPath}.extra.quasar`,
          fullRead: eventPointer,
        },
      ));
    }
    for (const context of executionContextsForEvent(mapped, event)) {
      entries.push(compatibilityEntry(
        "mapped_extension",
        "execution_context",
        "ATIF has no core execution-policy context; the exact record remains in Step.extra.",
        {
          sourceId: context.id,
          targetPath: `${stepPath}.extra.quasar.execution_contexts`,
          fullRead: eventPointer,
        },
      ));
    }
    for (const artifact of artifactsForEvent(mapped, event)) {
      entries.push(compatibilityEntry(
        "mapped_extension",
        "artifact",
        "ATIF has no core artifact record; the exact source artifact remains in Step.extra.",
        {
          sourceId: artifact.id,
          targetPath: `${stepPath}.extra.quasar.artifacts`,
          fullRead: eventPointer,
        },
      ));
    }
  }

  if (childProjections.length > 0) {
    const stepPath = `${path}.steps[${steps.length}]`;
    const references: AtifSubagentTrajectoryRef[] = [];
    for (const [index, childProjection] of childProjections.entries()) {
      const child = children[index]!;
      const edges = relationEdges(child, sessionId);
      for (const edge of edges) coreMappedEdgeIds.add(edge.id);
      references.push({
        trajectory_id: childProjection.trajectory.trajectory_id,
        session_id: child.session.sessionId,
        extra: {
          quasar: {
            parent_session_id: sessionId,
            child_session_id: child.session.sessionId,
            source_edge_ids: edges.map((edge) => edge.id),
          },
        },
      });
      entries.push(compatibilityEntry(
        "mapped_core",
        "session",
        "Observed parentSessionId maps to an embedded ATIF subagent reference.",
        {
          sourceId: child.session.sessionId,
          targetPath:
            `${stepPath}.observation.results[0].subagent_trajectory_ref[${index}]`,
          fullRead: sessionPointer(child.session.sessionId),
        },
      ));
      for (const edge of edges) {
        entries.push(compatibilityEntry(
          "mapped_core",
          "session_edge",
          "Observed subagent_of edge maps to an embedded ATIF subagent reference.",
          {
            sourceId: edge.id,
            targetPath:
              `${stepPath}.observation.results[0].subagent_trajectory_ref[${index}]`,
            fullRead: sessionPointer(child.session.sessionId),
          },
        ));
      }
    }
    steps.push({
      step_id: steps.length + 1,
      source: "system",
      message: "",
      observation: {
        results: [{
          subagent_trajectory_ref: references,
          extra: {
            quasar: {
              projection_event: "observed_subagent_relationships",
              source_session_id: sessionId,
            },
          },
        }],
      },
      extra: {
        quasar: {
          projection_step: true,
          source_event_id: null,
          reason:
            "Quasar observes session lineage but not a parent event boundary for every harness.",
        },
      },
    });
    entries.push(compatibilityEntry(
      "projection_adjustment",
      "session",
      "ATIF requires subagent references inside an observation; Quasar appended a source-marked system step because lineage is session-level.",
      {
        sourceId: sessionId,
        targetPath: stepPath,
        fullRead: sessionPointer(sessionId),
      },
    ));
  }

  const unboundUsage = mapped.usageRecords.filter((usage) =>
    usage.eventId === undefined
  );
  const unboundArtifacts = mapped.artifacts.filter((artifact) =>
    artifact.eventId === undefined
  );
  const sessionContexts = mapped.executionContexts.filter((context) =>
    context.scope === "session"
  );
  const rootExtra: AtifJsonObject = {
    quasar: {
      source_protocol_version: NORMALIZED_SESSION_PROTOCOL_VERSION,
      source_session_id: sessionId,
      project_key: mapped.session.projectKey,
      provider: mapped.session.provider,
      source_path: mapped.session.sourcePath,
      source_fingerprint: mapped.session.sourceFingerprint,
      host: mapped.session.host,
      identity_scheme_version: mapped.session.identitySchemeVersion,
      normalization_version: mapped.session.normalizationVersion,
      ...(mapped.session.parentSessionId !== undefined
        ? { parent_session_id: mapped.session.parentSessionId }
        : {}),
      ...(mapped.assignment !== undefined
        ? { assignment: toJsonValue(mapped.assignment) ?? {} }
        : {}),
      session_edges: mapped.sessionEdges.flatMap((edge) =>
        toJsonValue(edge) ?? []
      ),
      ...(sessionContexts.length > 0
        ? {
          execution_contexts: sessionContexts.flatMap((context) =>
            toJsonValue(context) ?? []
          ),
        }
        : {}),
      ...(unboundUsage.length > 0
        ? { unbound_usage_records: unboundUsage.map(usageJson) }
        : {}),
      ...(unboundArtifacts.length > 0
        ? {
          artifacts: unboundArtifacts.flatMap((artifact) =>
            toJsonValue(artifact) ?? []
          ),
        }
        : {}),
    },
  };
  const agentExtra: AtifJsonObject = {
    quasar: {
      provider: mapped.session.provider,
      agent_version_observed: false,
      ...(mapped.session.modelProvider !== undefined
        ? { model_provider: mapped.session.modelProvider }
        : {}),
      ...(mapped.assignment !== undefined
        ? { assignment: toJsonValue(mapped.assignment) ?? {} }
        : {}),
    },
  };
  const trajectory: AtifTrajectoryValue = {
    schema_version: HARBOR_ATIF_VERSION,
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: {
      name: mapped.session.agentName,
      version: "unobserved-by-quasar",
      ...(mapped.session.model !== undefined
        ? { model_name: mapped.session.model }
        : {}),
      extra: agentExtra,
    },
    steps,
    final_metrics: { total_steps: steps.length },
    extra: rootExtra,
    ...(childProjections.length > 0
      ? {
        subagent_trajectories: childProjections.map(
          (child) => child.trajectory,
        ),
      }
      : {}),
  };
  entries.push(compatibilityEntry(
    "mapped_core",
    "session",
    "Session identity, agent name, default model, and ordered events map to ATIF core fields; Quasar provenance remains in root extra.",
    {
      sourceId: sessionId,
      targetPath: path,
      fullRead: sessionPointer(sessionId),
    },
  ));
  entries.push(compatibilityEntry(
    "unobserved_atif_field",
    "atif_field",
    "ATIF requires Agent.version, but Quasar does not observe harness versions consistently; the explicit marker unobserved-by-quasar is used.",
    { targetPath: `${path}.agent.version` },
  ));
  for (const field of [
    "agent.tool_definitions",
    "steps[].llm_call_count",
    "steps[].metrics.prompt_token_ids",
    "steps[].metrics.completion_token_ids",
    "steps[].metrics.logprobs",
    "final_metrics token and cost aggregates",
  ]) {
    entries.push(compatibilityEntry(
      "unobserved_atif_field",
      "atif_field",
      "Quasar did not observe this ATIF field and did not infer or zero-fill it.",
      { targetPath: `${path}.${field}` },
    ));
  }
  for (const edge of mapped.sessionEdges) {
    if (coreMappedEdgeIds.has(edge.id)) continue;
    entries.push(compatibilityEntry(
      "mapped_extension",
      "session_edge",
      "ATIF has no equivalent core relationship for this source edge; the exact edge remains in root extra.",
      {
        sourceId: edge.id,
        targetPath: `${path}.extra.quasar.session_edges`,
        fullRead: sessionPointer(sessionId),
      },
    ));
  }
  for (const context of sessionContexts) {
    entries.push(compatibilityEntry(
      "mapped_extension",
      "execution_context",
      "ATIF has no core session execution-policy context; the exact record remains in root extra.",
      {
        sourceId: context.id,
        targetPath: `${path}.extra.quasar.execution_contexts`,
        fullRead: sessionPointer(sessionId),
      },
    ));
  }
  for (const usage of unboundUsage) {
    entries.push(compatibilityEntry(
      "mapped_extension",
      "usage_record",
      "The usage record has no event boundary, so Quasar preserved it without inferring an ATIF step or aggregate.",
      {
        sourceId: usage.id,
        targetPath: `${path}.extra.quasar.unbound_usage_records`,
        fullRead: sessionPointer(sessionId),
      },
    ));
  }
  for (const artifact of unboundArtifacts) {
    entries.push(compatibilityEntry(
      "mapped_extension",
      "artifact",
      "ATIF has no root artifact field; the exact source artifact remains in root extra.",
      {
        sourceId: artifact.id,
        targetPath: `${path}.extra.quasar.artifacts`,
        fullRead: sessionPointer(sessionId),
      },
    ));
  }
  return {
    trajectory: decodeAtifTrajectorySync(trajectory),
    entries,
  };
};

const countTrajectories = (trajectory: AtifTrajectoryValue): number =>
  1 + (trajectory.subagent_trajectories ?? [])
    .reduce((count, child) => count + countTrajectories(child), 0);

const countSteps = (trajectory: AtifTrajectoryValue): number =>
  trajectory.steps.length
  + (trajectory.subagent_trajectories ?? [])
    .reduce((count, child) => count + countSteps(child), 0);

export const toAtifTrajectory = (
  input: MappedSession,
  projectionInput: AtifProjectionInput = {},
): AtifTrajectoryExport => {
  const root = decodeMappedSessionSync(input);
  const projection = normalizedOptions(projectionInput);
  const sessions = [
    root,
    ...(projectionInput.subagentSessions ?? []).map((session) =>
      decodeMappedSessionSync(session)
    ),
  ];
  const byId = new Map<string, MappedSession>();
  for (const session of sessions) {
    const sessionId = session.session.sessionId;
    if (byId.has(sessionId)) {
      throw new Error(`duplicate ATIF source session ${sessionId}`);
    }
    byId.set(sessionId, session);
  }
  const childrenByParent = new Map<string, MappedSession[]>();
  for (const session of sessions.slice(1)) {
    const parentId = session.session.parentSessionId;
    if (parentId === undefined || !byId.has(parentId)) {
      throw new Error(
        `ATIF subagent source ${session.session.sessionId} has no supplied parent`,
      );
    }
    const children = childrenByParent.get(parentId) ?? [];
    children.push(session);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort((left, right) =>
      left.session.sessionId.localeCompare(right.session.sessionId)
    );
  }
  const coreMappedEdgeIds = new Set<string>();
  for (const session of sessions.slice(1)) {
    const parentId = session.session.parentSessionId;
    if (parentId === undefined) continue;
    for (const edge of relationEdges(session, parentId)) {
      coreMappedEdgeIds.add(edge.id);
    }
  }
  const projected = projectSingleAtif(
    root,
    "trajectory",
    projection,
    childrenByParent,
    new Set(),
    coreMappedEdgeIds,
  );
  if (countTrajectories(projected.trajectory) !== sessions.length) {
    throw new Error(
      "every supplied ATIF subagent session must be reachable from the root",
    );
  }
  const statuses = projected.entries.reduce(
    (counts, entry) => {
      counts[entry.status] += 1;
      return counts;
    },
    {
      mapped_core: 0,
      mapped_extension: 0,
      omitted_by_policy: 0,
      unobserved_atif_field: 0,
      projection_adjustment: 0,
    },
  );
  const exportValue = {
    format: QUASAR_ATIF_EXPORT_VERSION,
    schemaVersion: HARBOR_ATIF_VERSION,
    schemaId: HARBOR_ATIF_SCHEMA_ID,
    sourceProtocolVersion: NORMALIZED_SESSION_PROTOCOL_VERSION,
    schemaSource: {
      repository: HARBOR_ATIF_REPOSITORY,
      commit: HARBOR_ATIF_UPSTREAM_COMMIT,
      modelPath: HARBOR_ATIF_MODEL_PATH,
      validatorPath: HARBOR_ATIF_VALIDATOR_PATH,
    },
    trajectory: projected.trajectory,
    compatibility: {
      valid: true,
      validator: "quasar.atif-v1.7-mirror",
      checks: [
        "strict_fields",
        "source_specific_fields",
        "iso_timestamps",
        "sequential_step_ids",
        "tool_result_references",
        "subagent_reference_resolution",
        "embedded_subagent_ids",
      ],
      entries: projected.entries,
      counts: {
        sourceSessions: sessions.length,
        sourceEvents: sessions.reduce(
          (count, session) => count + session.events.length,
          0,
        ),
        sourceToolCalls: sessions.reduce(
          (count, session) => count + session.toolCalls.length,
          0,
        ),
        sourceUsageRecords: sessions.reduce(
          (count, session) => count + session.usageRecords.length,
          0,
        ),
        sourceSessionEdges: sessions.reduce(
          (count, session) => count + session.sessionEdges.length,
          0,
        ),
        sourceArtifacts: sessions.reduce(
          (count, session) => count + session.artifacts.length,
          0,
        ),
        sourceExecutionContexts: sessions.reduce(
          (count, session) => count + session.executionContexts.length,
          0,
        ),
        outputSteps: countSteps(projected.trajectory),
        embeddedSubagents: countTrajectories(projected.trajectory) - 1,
        mappedCore: statuses.mapped_core,
        mappedExtension: statuses.mapped_extension,
        omittedByPolicy: statuses.omitted_by_policy,
        unobservedAtifFields: statuses.unobserved_atif_field,
        projectionAdjustments: statuses.projection_adjustment,
      },
    },
  } as const;
  return Schema.decodeUnknownSync(
    AtifTrajectoryExport,
    strictParseOptions,
  )(exportValue);
};

const atifExampleSource = decodeMappedSessionSync(
  mappedSessionExamples[0]!.input,
);

export const atifTrajectoryExamples = [{
  name: "Harbor ATIF-v1.7 export with compatibility ledger",
  input: toAtifTrajectory(atifExampleSource),
}] as const;

export const harborAtifExamples = [{
  name: "Harbor ATIF-v1.7 trajectory",
  input: atifTrajectoryExamples[0].input.trajectory,
}] as const;
