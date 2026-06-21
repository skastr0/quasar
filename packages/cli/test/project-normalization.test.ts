import { describe, expect, test } from "vitest";

import {
  normalizeGitRemote,
  resolveProjectIdentity,
} from "../src/core/project-normalization";

describe("project normalization", () => {
  test("normalizes ssh and https git remotes to the same identity", () => {
    expect(normalizeGitRemote("git@github.com:Skastr0/Quasar.git")).toBe(
      "github.com/skastr0/quasar",
    );
    expect(normalizeGitRemote("https://github.com/skastr0/quasar")).toBe(
      "github.com/skastr0/quasar",
    );
  });

  test("uses git remote before absolute paths", () => {
    const a = resolveProjectIdentity({
      machineId: "machine:a",
      rawPath: "/Users/a/Projects/quasar",
      gitRemote: "git@github.com:skastr0/quasar.git",
    });
    const b = resolveProjectIdentity({
      machineId: "machine:b",
      rawPath: "/home/b/work/quasar",
      gitRemote: "https://github.com/skastr0/quasar.git",
    });
    expect(a.projectIdentityKey).toBe(b.projectIdentityKey);
    expect(a.confidence).toBe("high");
  });

  test("keeps low-confidence path identities machine-specific", () => {
    const a = resolveProjectIdentity({
      machineId: "machine:a",
      rawPath: "/Users/a/Projects/quasar",
    });
    const b = resolveProjectIdentity({
      machineId: "machine:b",
      rawPath: "/Users/a/Projects/quasar",
    });
    expect(a.projectIdentityKey).not.toBe(b.projectIdentityKey);
    expect(a.confidence).toBe("low");
  });
});
