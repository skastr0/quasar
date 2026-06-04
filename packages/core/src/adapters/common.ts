import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { stableJsonHash, stableWideHash } from "../hash";
import { resolveProjectIdentity } from "../project-normalization";
import type {
  MachineIdentity,
  NormalizedSession,
  Provider,
  SessionEvent,
  SessionEventKind,
  SessionRole,
  SourceRoot,
  ToolCall,
} from "../schemas";

export type NativeValue =
  | string
  | number
  | boolean
  | null
  | readonly NativeValue[]
  | { readonly [key: string]: NativeValue | undefined };

type BuildSessionArgs = {
  readonly provider: Provider;
  readonly agentName: string;
  readonly machine: MachineIdentity;
  readonly nativeSessionId: string;
  readonly nativeProjectKey?: string;
  readonly title?: string;
  readonly sourceRoot: string;
  readonly sourcePath: string;
  readonly projectPath?: string;
  readonly gitRemote?: string;
  readonly packageName?: string;
  readonly rawMetadata?: NativeValue;
  readonly events: Omit<
    SessionEvent,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
  readonly toolCalls?: Omit<
    ToolCall,
    "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
  >[];
};

export const homePath = (relative: string) => {
  const home = process.env.HOME;
  return home === undefined ? undefined : join(home, relative);
};

export const readJsonLines = (path: string) => {
  const contents = readFileSync(path, "utf8");
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim().length > 0)
    .flatMap(({ line, lineNumber }) => {
      try {
        return [{ value: JSON.parse(line) as unknown, lineNumber }];
      } catch {
        return [];
      }
    });
};

export const readJsonFile = (path: string) => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

export const collectFiles = (
  root: string,
  predicate: (path: string) => boolean,
  limit = Number.POSITIVE_INFINITY,
) => {
  const input = parseCollectFilesInput(root, limit);
  if (input === undefined) return [];
  const files: string[] = [];
  const visit = (path: string) => {
    if (files.length >= input.limit) return;
    let stat;
    try {
      stat = statSync(path);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (predicate(path)) files.push(path);
  };
  if (existsSync(input.root)) visit(input.root);
  return files.sort();
};

export const compactText = (value: NativeValue | undefined): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length === 0 ? undefined : text;
  }
  if (Array.isArray(value)) {
    const text = value.map(compactText).filter(Boolean).join(" ").trim();
    return text.length === 0 ? undefined : text;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return compactText(record.text);
    if (typeof record.content === "string") return compactText(record.content);
    try {
      return JSON.stringify(value).slice(0, 4_000);
    } catch {
      return undefined;
    }
  }
  return String(value);
};

export const roleFrom = (value: string | undefined): SessionRole => {
  if (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "tool" ||
    value === "thinking"
  ) {
    return value;
  }
  return "unknown";
};

export const kindFromNative = (type: string | undefined): SessionEventKind => {
  if (type === undefined) return "unknown";
  if (type.includes("tool") && type.includes("result")) return "tool_result";
  if (type.includes("tool")) return "tool_call";
  if (type.includes("thinking") || type.includes("reasoning")) return "reasoning";
  if (type.includes("summary") || type === "compacted") return "summary";
  if (type.includes("snapshot") || type.includes("diff")) return "snapshot";
  if (type === "user" || type === "assistant" || type === "message") {
    return "message";
  }
  if (type === "system" || type === "session_meta") return "system";
  if (type.includes("phase") || type.includes("turn") || type.includes("loop")) {
    return "lifecycle";
  }
  return "unknown";
};

export const sourceRoot = (
  provider: Provider,
  adapterId: string,
  rootPath: string,
  machine: MachineIdentity,
  now: string,
): SourceRoot => ({
  provider,
  adapterId,
  rootPath,
  machineId: machine.machineId,
  discoveredAt: now,
});

export const buildSession = (input: BuildSessionArgs): NormalizedSession => {
  const args = parseBuildSessionArgs(input);
  const projectIdentity = resolveProjectIdentity({
    machineId: args.machine.machineId,
    rawPath: args.projectPath ?? args.nativeProjectKey,
    gitRemote: args.gitRemote,
    packageName: args.packageName,
  });
  const id = `${args.provider}:${args.machine.machineId}:${stableWideHash(
    `${args.nativeSessionId}:${args.sourcePath}`,
  )}`;
  const events = args.events.map((event) => ({
    ...event,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
  }));
  const toolCalls = (args.toolCalls ?? []).map((toolCall) => ({
    ...toolCall,
    sessionId: id,
    machineId: args.machine.machineId,
    provider: args.provider,
    agentName: args.agentName,
    projectIdentityKey: projectIdentity.projectIdentityKey,
  }));

  return {
    id,
    nativeSessionId: args.nativeSessionId,
    provider: args.provider,
    agentName: args.agentName,
    machineId: args.machine.machineId,
    projectIdentity,
    ...(args.nativeProjectKey !== undefined
      ? { nativeProjectKey: args.nativeProjectKey }
      : {}),
    ...(args.title !== undefined ? { title: args.title } : {}),
    sourceRoot: args.sourceRoot,
    sourcePath: args.sourcePath,
    ...(args.rawMetadata !== undefined ? { rawMetadata: args.rawMetadata } : {}),
    events,
    toolCalls,
  };
};

export const eventIdFor = (
  provider: Provider,
  sourcePath: string,
  sequence: number,
  stableKey: string | number,
) => `${provider}:event:${stableJsonHash([sourcePath, sequence, stableKey])}`;

export const nativeSessionIdFromPath = (path: string) =>
  basename(path).replace(/\.(jsonl|json|db)$/i, "");

export const parentDirectoryName = (path: string) => basename(dirname(path));

const parseCollectFilesInput = (root: string, limit: number) => {
  const trimmedRoot = root.trim();
  if (trimmedRoot.length === 0 || limit <= 0) return undefined;
  return {
    root: trimmedRoot,
    limit: Number.isFinite(limit) ? Math.floor(limit) : Number.POSITIVE_INFINITY,
  };
};

const parseBuildSessionArgs = (args: BuildSessionArgs) => {
  if (args.nativeSessionId.trim().length === 0) {
    throw new Error("Native session ID cannot be empty.");
  }
  if (args.sourceRoot.trim().length === 0 || args.sourcePath.trim().length === 0) {
    throw new Error("Session source paths cannot be empty.");
  }
  return args;
};
