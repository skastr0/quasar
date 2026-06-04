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
  const rawPath = hints.rawPath?.trim();
  const normalizedPath =
    rawPath !== undefined && rawPath.length > 0 ? compactPath(rawPath) : undefined;

  if (hints.explicitProjectKey?.trim()) {
    const value = hints.explicitProjectKey.trim();
    signals.push(signal("explicit", value, "explicit"));
    return {
      projectIdentityKey: `project:${value}`,
      displayName: value,
      confidence: "explicit",
      ...(rawPath !== undefined ? { rawPath } : {}),
      ...(normalizedPath !== undefined ? { normalizedPath } : {}),
      ...(hints.gitRemote !== undefined ? { gitRemote: hints.gitRemote } : {}),
      ...(hints.packageName !== undefined ? { packageName: hints.packageName } : {}),
      signals,
    };
  }

  const normalizedRemote =
    hints.gitRemote === undefined ? undefined : normalizeGitRemote(hints.gitRemote);
  if (normalizedRemote !== undefined) {
    signals.push(signal("git_remote", normalizedRemote, "high"));
    return {
      projectIdentityKey: `git:${normalizedRemote}`,
      displayName: normalizedRemote.split("/").slice(-1)[0] ?? normalizedRemote,
      confidence: "high",
      ...(rawPath !== undefined ? { rawPath } : {}),
      ...(normalizedPath !== undefined ? { normalizedPath } : {}),
      gitRemote: hints.gitRemote,
      gitRemoteNormalized: normalizedRemote,
      ...(hints.packageName !== undefined ? { packageName: hints.packageName } : {}),
      signals,
    };
  }

  if (hints.packageName?.trim()) {
    const packageName = hints.packageName.trim();
    signals.push(signal("package", packageName, "medium"));
    return {
      projectIdentityKey: `package:${packageName}`,
      displayName: packageName,
      confidence: "medium",
      ...(rawPath !== undefined ? { rawPath } : {}),
      ...(normalizedPath !== undefined ? { normalizedPath } : {}),
      packageName,
      signals,
    };
  }

  if (hints.workspaceName?.trim()) {
    const workspaceName = hints.workspaceName.trim();
    signals.push(signal("workspace", workspaceName, "medium"));
    return {
      projectIdentityKey: `workspace:${workspaceName}`,
      displayName: workspaceName,
      confidence: "medium",
      ...(rawPath !== undefined ? { rawPath } : {}),
      ...(normalizedPath !== undefined ? { normalizedPath } : {}),
      signals,
    };
  }

  const fallbackPath =
    normalizedPath ?? resolve(process.env.HOME ?? "/", "unknown-project");
  signals.push(signal("path", fallbackPath, "low"));
  return {
    projectIdentityKey: `path:${hints.machineId}:${stableWideHash(fallbackPath)}`,
    displayName: pathDisplayName(fallbackPath),
    confidence: "low",
    ...(rawPath !== undefined ? { rawPath } : {}),
    normalizedPath: fallbackPath,
    signals,
  };
};
