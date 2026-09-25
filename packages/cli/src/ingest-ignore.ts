import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import type { NormalizedSession } from "./core/schemas";
import { normalizeGitRemote } from "./core/project-normalization";
import { defaultClientConfigPath } from "./client-config";

/**
 * Ingest ignore list: sessions that never leave this machine.
 *
 * Declared as `ignore` in the client config (`~/.config/quasar/config.json` or
 * `QUASAR_CONFIG`):
 *
 *   "ignore": {
 *     "paths": ["~/Work/private"],
 *     "gitRemotes": ["github.com/acme/private"],
 *     "projectKeys": ["<projectIdentityKey or provider-native project key>"],
 *     "models": ["acme/*", "*\/model-x-v2", "openai/gpt-x"]
 *   }
 *
 * A matching session is dropped at the ingest boundary, before it is mapped
 * or sent to the server. Every rule kind only widens what is blocked:
 *
 * - paths: the session's project directory or source file lies at or under the
 *   directory, OR the directory's absolute path (or its `~/` form) appears
 *   anywhere in the session — any message, tool input or output, artifact.
 * - gitRemotes: the session's project resolves to the remote, or the normalized
 *   remote appears anywhere in the session.
 * - projectKeys: the session's Quasar or provider-native project key.
 * - models: any execution context or usage record names a matching
 *   `provider/model`; `*` matches any run of characters on either side.
 *
 * All matching is case-insensitive, so a rule can over-block, never
 * under-block. Fail closed: an unreadable config, an unknown key under
 * `ignore`, or a malformed entry aborts ingest before any provider is read.
 */

export class IngestIgnoreConfigError extends Error {
  override readonly name = "IngestIgnoreConfigError";
}

export type IngestIgnoreKind = "paths" | "gitRemotes" | "projectKeys" | "models";

export interface IngestIgnoreRules {
  readonly paths: readonly PathRule[];
  readonly gitRemotes: readonly ValueRule[];
  readonly projectKeys: readonly ValueRule[];
  readonly models: readonly ModelRule[];
}

interface PathRule {
  readonly entry: string;
  /** Case-folded absolute forms: literal and, when it exists, the real path. */
  readonly prefixes: readonly string[];
  /** Case-folded strings whose appearance anywhere in a session blocks it. */
  readonly mentions: readonly string[];
}

interface ValueRule {
  readonly entry: string;
  readonly value: string;
}

interface ModelRule {
  readonly entry: string;
  readonly provider: RegExp;
  readonly model: RegExp;
}

/** Why a session was excluded: the rule kind and the entry as written. */
export interface IngestIgnoreMatch {
  readonly kind: IngestIgnoreKind;
  readonly entry: string;
}

export const emptyIgnoreRules: IngestIgnoreRules = { paths: [], gitRemotes: [], projectKeys: [], models: [] };

const ruleKinds: readonly IngestIgnoreKind[] = ["paths", "gitRemotes", "projectKeys", "models"];

const trimTrailingSlash = (path: string): string =>
  path.length > 1 ? path.replace(/\/+$/, "") : path;

const expandHome = (path: string, home: string): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const fold = (path: string): string => trimTrailingSlash(normalize(path)).toLowerCase();

const entriesOf = (kind: IngestIgnoreKind, value: unknown): string[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new IngestIgnoreConfigError(`ignore.${kind} must be an array of strings`);
  return value.map((raw, index) => {
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new IngestIgnoreConfigError(`ignore.${kind}[${index}] must be a non-empty string`);
    }
    return raw.trim();
  });
};

const pathRule = (entry: string, index: number, home: string): PathRule => {
  const expanded = expandHome(entry, home);
  if (!isAbsolute(expanded)) {
    throw new IngestIgnoreConfigError(`ignore.paths[${index}] must be absolute or start with ~/: ${entry}`);
  }
  const prefixes = new Set([fold(expanded)]);
  try {
    if (existsSync(expanded)) prefixes.add(fold(realpathSync(expanded)));
  } catch {
    // The literal form still applies; an unresolvable symlink cannot widen it.
  }
  if (prefixes.has("/")) {
    throw new IngestIgnoreConfigError(`ignore.paths[${index}] would block every session: ${entry}`);
  }
  const homePrefix = `${fold(home)}/`;
  const mentions = new Set<string>();
  for (const prefix of prefixes) {
    mentions.add(prefix);
    if (prefix.startsWith(homePrefix)) mentions.add(`~/${prefix.slice(homePrefix.length)}`);
  }
  return { entry, prefixes: [...prefixes], mentions: [...mentions] };
};

const globPattern = (glob: string): RegExp =>
  new RegExp(`^${glob.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");

const modelRule = (entry: string): ModelRule => {
  const slash = entry.indexOf("/");
  const provider = slash === -1 ? "*" : entry.slice(0, slash);
  const model = slash === -1 ? entry : entry.slice(slash + 1);
  return { entry, provider: globPattern(provider || "*"), model: globPattern(model || "*") };
};

export const parseIgnoreRules = (value: unknown, home: string = homedir()): IngestIgnoreRules => {
  if (value === undefined) return emptyIgnoreRules;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new IngestIgnoreConfigError("ignore must be an object with paths, gitRemotes, projectKeys, or models");
  }
  const record = value as Record<string, unknown>;
  const unknownKey = Object.keys(record).find((key) => !(ruleKinds as readonly string[]).includes(key));
  if (unknownKey !== undefined) {
    throw new IngestIgnoreConfigError(`ignore.${unknownKey} is not a rule kind; expected one of ${ruleKinds.join(", ")}`);
  }
  return {
    paths: entriesOf("paths", record.paths).map((entry, index) => pathRule(entry, index, home)),
    gitRemotes: entriesOf("gitRemotes", record.gitRemotes).map((entry, index) => {
      const normalized = normalizeGitRemote(entry);
      if (normalized === undefined) throw new IngestIgnoreConfigError(`ignore.gitRemotes[${index}] is not a git remote: ${entry}`);
      return { entry, value: normalized };
    }),
    projectKeys: entriesOf("projectKeys", record.projectKeys).map((entry) => ({ entry, value: entry.toLowerCase() })),
    models: entriesOf("models", record.models).map(modelRule),
  };
};

/** Load the ignore rules from the client config. Throws on any malformed config. */
export const configuredIgnoreRules = (env: NodeJS.ProcessEnv = process.env): IngestIgnoreRules => {
  const path = defaultClientConfigPath(env);
  if (!existsSync(path)) return emptyIgnoreRules;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (cause) {
    throw new IngestIgnoreConfigError(
      `cannot read ${path}; refusing to ingest without its ignore rules: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IngestIgnoreConfigError(`${path} must contain a JSON object`);
  }
  const record = parsed as Record<string, unknown>;
  // A misspelled key would silently disable protection, so refuse it.
  const misspelled = Object.keys(record).find((key) => key !== "ignore" && key.toLowerCase().startsWith("ignore"));
  if (misspelled !== undefined) {
    throw new IngestIgnoreConfigError(`${path}: ${misspelled} is not read; ignore rules live under "ignore"`);
  }
  return parseIgnoreRules(record.ignore, env.HOME ?? homedir());
};

const hasRules = (rules: IngestIgnoreRules): boolean =>
  rules.paths.length + rules.gitRemotes.length + rules.projectKeys.length + rules.models.length > 0;

const underPrefix = (path: string, prefix: string): boolean =>
  path === prefix || path.startsWith(`${prefix}/`);

const modelNames = (session: NormalizedSession): { provider: string; model: string }[] => {
  const names: { provider: string; model: string }[] = [];
  for (const record of [...session.executionContexts, ...session.usageRecords]) {
    if (record.model === undefined && record.modelProvider === undefined) continue;
    const model = record.model ?? "";
    const slash = model.indexOf("/");
    names.push({ provider: record.modelProvider ?? "", model });
    // Providers that embed the provider in the model id ("acme/model-x-v2").
    if (slash !== -1) names.push({ provider: model.slice(0, slash), model: model.slice(slash + 1) });
  }
  return names;
};

/** The first rule that excludes this session, or undefined when it may be ingested. */
export const ignoreMatchFor = (
  session: NormalizedSession,
  rules: IngestIgnoreRules,
  home: string = homedir(),
): IngestIgnoreMatch | undefined => {
  if (!hasRules(rules)) return undefined;
  const identity = session.projectIdentity;

  const keys = [identity.projectIdentityKey, session.nativeProjectKey]
    .filter((key): key is string => key !== undefined)
    .map((key) => key.toLowerCase());
  const key = rules.projectKeys.find((rule) => keys.includes(rule.value));
  if (key !== undefined) return { kind: "projectKeys", entry: key.entry };

  const names = modelNames(session);
  const model = rules.models.find((rule) =>
    names.some((name) => rule.provider.test(name.provider) && rule.model.test(name.model)));
  if (model !== undefined) return { kind: "models", entry: model.entry };

  const paths = [identity.rawPath, identity.normalizedPath, session.sourcePath]
    .filter((path): path is string => path !== undefined && path.trim().length > 0)
    .map((path) => fold(expandHome(path.trim(), home)));
  const structuralPath = rules.paths.find((rule) =>
    rule.prefixes.some((prefix) => paths.some((path) => underPrefix(path, prefix))));
  if (structuralPath !== undefined) return { kind: "paths", entry: structuralPath.entry };

  const remote = identity.gitRemoteNormalized?.toLowerCase();
  const structuralRemote = rules.gitRemotes.find((rule) => rule.value === remote);
  if (structuralRemote !== undefined) return { kind: "gitRemotes", entry: structuralRemote.entry };

  if (rules.paths.length + rules.gitRemotes.length === 0) return undefined;
  // Mention scan over every field of the session: a session started anywhere
  // that reads, writes, or quotes an ignored directory or repo is ignored too.
  const text = JSON.stringify(session).toLowerCase();
  const mentionedPath = rules.paths.find((rule) => rule.mentions.some((mention) => text.includes(mention)));
  if (mentionedPath !== undefined) return { kind: "paths", entry: mentionedPath.entry };
  const mentionedRemote = rules.gitRemotes.find((rule) => text.includes(rule.value));
  if (mentionedRemote !== undefined) return { kind: "gitRemotes", entry: mentionedRemote.entry };
  return undefined;
};
