import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SessionAdapter } from "./types";
import {
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  kindFromNative,
  nativeSessionIdFromPath,
  parentDirectoryName,
  readJsonLines,
  roleFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

const projectPathFromClaudeKey = (key: string) =>
  key.startsWith("-") ? key.replace(/^-/, "/").replaceAll("-", "/") : key;

export const claudeAdapter: SessionAdapter = {
  id: "claude-code-project-jsonl",
  provider: "claude",
  displayName: "Claude Code project JSONL",
  stable: true,
  defaultRoot: () => process.env.CLAUDE_CONFIG_DIR ?? homePath(".claude"),
  read: async (options) => {
    const root = options.roots?.claude ?? claudeAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: claudeAdapter.id,
            provider: "claude",
            status: "no_data_found",
            message: "Claude root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const projectsRoot = join(root, "projects");
    const files = collectFiles(projectsRoot, (path) => path.endsWith(".jsonl"), options.limit);
    const rootRecord = sourceRoot("claude", claudeAdapter.id, projectsRoot, options.machine, options.now);
    const sessions = files.map((path) => {
      const lines = readJsonLines(path);
      const projectKey = parentDirectoryName(path);
      const firstRecord = lines[0]?.value as Record<string, unknown> | undefined;
      const projectPath =
        typeof firstRecord?.cwd === "string"
          ? firstRecord.cwd
          : projectPathFromClaudeKey(projectKey);
      const events = lines.map(({ value, lineNumber }, index) => {
        const record =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        const type = typeof record.type === "string" ? record.type : "unknown";
        const message =
          record.message !== null && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : undefined;
        const content = (message?.content ?? record) as NativeValue;
        const nativeEventId = typeof record.uuid === "string" ? record.uuid : undefined;
        return {
          id: eventIdFor("claude", path, index, nativeEventId ?? lineNumber),
          nativeEventId,
          parentEventId:
            typeof record.parentUuid === "string" ? record.parentUuid : undefined,
          sequence: index,
          timestamp:
            typeof record.timestamp === "string" ? record.timestamp : undefined,
          role: roleFrom(
            typeof message?.role === "string" ? message.role : type,
          ),
          kind: kindFromNative(type),
          contentText: compactText(content),
          content,
          rawReference: { sourcePath: path, line: lineNumber, nativeType: type },
          raw: value,
        };
      });
      return buildSession({
        provider: "claude",
        agentName: "claude-code",
        machine: options.machine,
        nativeSessionId: nativeSessionIdFromPath(path),
        nativeProjectKey: projectKey,
        sourceRoot: projectsRoot,
        sourcePath: path,
        projectPath,
        rawMetadata: firstRecord as NativeValue | undefined,
        events,
      });
    });

    return {
      sourceRoots: [rootRecord],
      sessions,
      diagnostics: [
        {
          adapterId: claudeAdapter.id,
          provider: "claude",
          status: sessions.length > 0 ? "available" : "no_data_found",
          rootPath: projectsRoot,
          message: `Discovered ${sessions.length} Claude session(s).`,
        },
      ],
    };
  },
};
