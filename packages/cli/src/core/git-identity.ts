import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Local-filesystem git-remote lookup for the project identity ladder
 * (explicit key → git remote → package → workspace → path). Provider sources
 * record only a working directory; when that directory is (or was inside) a
 * local clone, the clone's remote is the canonical cross-provider identity,
 * so sessions from every provider that ran in the same repository unify on
 * one `git:` projectKey instead of splintering into per-path keys.
 *
 * The walk starts at the recorded path and climbs to the filesystem root,
 * skipping path segments that no longer exist (session cwds can be deleted),
 * and reads the first remote URL out of `.git/config` — no subprocesses, no
 * locks, safe against live repositories.
 */

const remoteByDirectory = new Map<string, string | undefined>();

const firstRemoteUrl = (configText: string): string | undefined => {
  let originUrl: string | undefined;
  let fallbackUrl: string | undefined;
  let section: string | undefined;
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[remote "([^"]+)"\]$/.exec(line);
    if (sectionMatch !== null) {
      section = sectionMatch[1];
      continue;
    }
    if (line.startsWith("[")) {
      section = undefined;
      continue;
    }
    if (section === undefined) continue;
    const urlMatch = /^url\s*=\s*(.+)$/.exec(line);
    if (urlMatch === null) continue;
    const url = urlMatch[1]?.trim();
    if (url === undefined || url.length === 0) continue;
    if (section === "origin") {
      originUrl ??= url;
    } else {
      fallbackUrl ??= url;
    }
  }
  return originUrl ?? fallbackUrl;
};

/** Resolves a `.git` entry (directory, or worktree/submodule pointer file) to its config path. */
const gitConfigPathFor = (gitEntry: string): string | undefined => {
  try {
    const stats = statSync(gitEntry);
    if (stats.isDirectory()) return join(gitEntry, "config");
    const pointerMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(gitEntry, "utf8"));
    const gitDir = pointerMatch?.[1]?.trim();
    if (gitDir === undefined || gitDir.length === 0) return undefined;
    const absoluteGitDir = isAbsolute(gitDir) ? gitDir : resolve(dirname(gitEntry), gitDir);
    // Linked worktrees live under <main>/.git/worktrees/<name>; the remote
    // configuration belongs to the main repository's config.
    const worktreeMatch = /^(.*\/\.git)\/worktrees\/[^/]+$/.exec(absoluteGitDir);
    return join(worktreeMatch?.[1] ?? absoluteGitDir, "config");
  } catch {
    return undefined;
  }
};

const remoteAtDirectory = (directory: string): string | undefined => {
  const configPath = gitConfigPathFor(join(directory, ".git"));
  if (configPath === undefined || !existsSync(configPath)) return undefined;
  try {
    return firstRemoteUrl(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * Returns the raw git remote URL for the repository containing `path`, or
 * undefined when no local clone (with a remote) encloses it. Results are
 * cached per directory; the whole estate touches only a few dozen roots.
 */
export const gitRemoteForPath = (path: string | undefined): string | undefined => {
  if (path === undefined || !isAbsolute(path.trim())) return undefined;
  const walked: string[] = [];
  let remote: string | undefined;
  let directory = resolve(path.trim());
  for (;;) {
    if (remoteByDirectory.has(directory)) {
      remote = remoteByDirectory.get(directory);
      break;
    }
    walked.push(directory);
    // The first enclosing repository decides: a remote-less local clone is a
    // path-keyed project, never attributed to an outer repository's remote.
    if (existsSync(join(directory, ".git"))) {
      remote = remoteAtDirectory(directory);
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const visited of walked) {
    remoteByDirectory.set(visited, remote);
  }
  return remote;
};
