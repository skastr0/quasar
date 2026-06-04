import { basename, normalize, resolve } from "node:path";

import type { ProjectResolution, ProjectSignal } from "./schemas";
import { stableWideHash } from "./hash";

export interface ProjectHints {
  readonly machineId: string;
  readonly rawPath?: string;
  readonly explicitProjectKey?: string;
  readonly gitRemote?: string;
  readonly packageName?: string;
  readonly workspaceName?: string;
}

const compactPath = (path: string) => normalize(path).replace(/\/+$/, "");

const cleanRemotePath = (path: string) =>
  path.replace(/^\/+/, "").replace(/\.git$/i, "").replace(/\/+$/, "");

const remoteFromScpLike = (value: string) => {
  const match = /^(?:[^@]+@)?([^:]+):(.+)$/.exec(value);
  if (match === null || value.includes("://")) return undefined;
  return { host: match[1] ?? "", path: match[2] ?? "" };
};

export const normalizeGitRemote = (remote: string) => {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;

  const scp = remoteFromScpLike(trimmed);
  if (scp !== undefined) {
    const path = cleanRemotePath(scp.path).toLowerCase();
    return `${scp.host.toLowerCase()}/${path}`;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const path = cleanRemotePath(url.pathname).toLowerCase();
    if (host.length === 0 || path.length === 0) return undefined;
    return `${host}/${path}`;
  } catch {
    const cleaned = cleanRemotePath(trimmed).toLowerCase();
    return cleaned.length === 0 ? undefined : cleaned;
  }
};

const pathDisplayName = (rawPath: string | undefined) => {
  if (rawPath === undefined || rawPath.trim().length === 0) return "unknown";
  return basename(compactPath(rawPath)) || compactPath(rawPath);
};

const signal = (
  kind: ProjectSignal["kind"],
  value: string,
  confidence: ProjectSignal["confidence"],
): ProjectSignal => ({ kind, value, confidence });

export const resolveProjectIdentity = (
  hints: ProjectHints,
): ProjectResolution => {
  const signals: ProjectSignal[] = [];
  const context = projectPathContext(hints);
  return (
    explicitProject(hints, context, signals) ??
    gitRemoteProject(hints, context, signals) ??
    packageProject(hints, context, signals) ??
    workspaceProject(hints, context, signals) ??
    fallbackProject(hints, context, signals)
  );
};

type ProjectPathContext = {
  readonly rawPath?: string;
  readonly normalizedPath?: string;
};

const projectPathContext = (hints: ProjectHints): ProjectPathContext => {
  const rawPath = hints.rawPath?.trim();
  return {
    ...(rawPath !== undefined ? { rawPath } : {}),
    ...(rawPath !== undefined && rawPath.length > 0
      ? { normalizedPath: compactPath(rawPath) }
      : {}),
  };
};

const commonFields = (
  hints: ProjectHints,
  context: ProjectPathContext,
) => ({
  ...context,
  ...(hints.gitRemote !== undefined ? { gitRemote: hints.gitRemote } : {}),
  ...(hints.packageName !== undefined ? { packageName: hints.packageName } : {}),
});

const explicitProject = (
  hints: ProjectHints,
  context: ProjectPathContext,
  signals: ProjectSignal[],
) => {
  if (!hints.explicitProjectKey?.trim()) return undefined;
  const value = hints.explicitProjectKey.trim();
  signals.push(signal("explicit", value, "explicit"));
  return {
    projectIdentityKey: `project:${value}`,
    displayName: value,
    confidence: "explicit" as const,
    ...commonFields(hints, context),
    signals,
  };
};

const gitRemoteProject = (
  hints: ProjectHints,
  context: ProjectPathContext,
  signals: ProjectSignal[],
) => {
  const normalizedRemote =
    hints.gitRemote === undefined ? undefined : normalizeGitRemote(hints.gitRemote);
  if (normalizedRemote === undefined) return undefined;
  signals.push(signal("git_remote", normalizedRemote, "high"));
  return {
    projectIdentityKey: `git:${normalizedRemote}`,
    displayName: normalizedRemote.split("/").slice(-1)[0] ?? normalizedRemote,
    confidence: "high" as const,
    ...commonFields(hints, context),
    gitRemoteNormalized: normalizedRemote,
    signals,
  };
};

const packageProject = (
  hints: ProjectHints,
  context: ProjectPathContext,
  signals: ProjectSignal[],
) => namedProject("package", hints.packageName, context, signals);

const workspaceProject = (
  hints: ProjectHints,
  context: ProjectPathContext,
  signals: ProjectSignal[],
) => namedProject("workspace", hints.workspaceName, context, signals);

const namedProject = (
  kind: "package" | "workspace",
  value: string | undefined,
  context: ProjectPathContext,
  signals: ProjectSignal[],
) => {
  if (!value?.trim()) return undefined;
  const name = value.trim();
  signals.push(signal(kind, name, "medium"));
  return {
    projectIdentityKey: `${kind}:${name}`,
    displayName: name,
    confidence: "medium" as const,
    ...context,
    ...(kind === "package" ? { packageName: name } : {}),
    signals,
  };
};

const fallbackProject = (
  hints: ProjectHints,
  context: ProjectPathContext,
  signals: ProjectSignal[],
): ProjectResolution => {
  const fallbackPath =
    context.normalizedPath ?? resolve(process.env.HOME ?? "/", "unknown-project");
  signals.push(signal("path", fallbackPath, "low"));
  return {
    projectIdentityKey: `path:${hints.machineId}:${stableWideHash(fallbackPath)}`,
    displayName: pathDisplayName(fallbackPath),
    confidence: "low",
    ...(context.rawPath !== undefined ? { rawPath: context.rawPath } : {}),
    normalizedPath: fallbackPath,
    signals,
  };
};
