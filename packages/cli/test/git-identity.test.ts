import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { gitRemoteForPath } from "../src/core/git-identity";
import { resolveProjectIdentity } from "../src/core/project-normalization";

const root = mkdtempSync(join(tmpdir(), "quasar-git-identity-"));

const writeRepo = (path: string, url?: string) => {
  mkdirSync(join(path, ".git"), { recursive: true });
  writeFileSync(
    join(path, ".git", "config"),
    url === undefined
      ? "[core]\n\trepositoryformatversion = 0\n"
      : `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
  );
};

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("git identity", () => {
  test("resolves the remote of the clone enclosing a path, including deleted subpaths", () => {
    const repo = join(root, "clone");
    writeRepo(repo, "git@github.com:skastr0/quasar.git");

    expect(gitRemoteForPath(repo)).toBe("git@github.com:skastr0/quasar.git");
    // Subdirectory of the clone — including one that no longer exists
    // (session cwds outlive their directories).
    expect(gitRemoteForPath(join(repo, "packages", "cli"))).toBe(
      "git@github.com:skastr0/quasar.git",
    );
  });

  test("returns undefined outside any clone and for relative or missing paths", () => {
    mkdirSync(join(root, "plain"), { recursive: true });
    expect(gitRemoteForPath(join(root, "plain"))).toBeUndefined();
    expect(gitRemoteForPath(undefined)).toBeUndefined();
    expect(gitRemoteForPath("not/absolute")).toBeUndefined();
  });

  test("a remote-less inner clone is not attributed to an outer repository", () => {
    const outer = join(root, "outer");
    writeRepo(outer, "git@github.com:skastr0/outer.git");
    const inner = join(outer, "vendored");
    writeRepo(inner);
    expect(gitRemoteForPath(inner)).toBeUndefined();
    expect(gitRemoteForPath(outer)).toBe("git@github.com:skastr0/outer.git");
  });

  test("follows linked-worktree pointer files to the main repository's config", () => {
    const main = join(root, "main");
    writeRepo(main, "https://github.com/skastr0/quasar.git");
    mkdirSync(join(main, ".git", "worktrees", "wt"), { recursive: true });
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt")}\n`);
    expect(gitRemoteForPath(worktree)).toBe("https://github.com/skastr0/quasar.git");
  });

  test("unifies cross-provider sessions of one repository on a single git projectKey", () => {
    const repo = join(root, "clone");
    const fromPath = resolveProjectIdentity({
      machineId: "machine:a",
      rawPath: join(repo, "src"),
      gitRemote: gitRemoteForPath(join(repo, "src")),
    });
    const fromRemote = resolveProjectIdentity({
      machineId: "machine:b",
      rawPath: "/somewhere/else/quasar",
      gitRemote: "https://github.com/skastr0/quasar.git",
    });
    expect(fromPath.projectIdentityKey).toBe("git:github.com/skastr0/quasar");
    expect(fromPath.projectIdentityKey).toBe(fromRemote.projectIdentityKey);
  });
});
