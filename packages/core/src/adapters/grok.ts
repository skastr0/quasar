import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { SessionAdapter } from "./types";
import {
  buildSession,
  collectFiles,
  compactText,
  eventIdFor,
  homePath,
  readJsonFile,
  readJsonLines,
  roleFrom,
  sourceRoot,
} from "./common";

const decodeProjectPath = (encoded: string) => {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

export const grokAdapter: SessionAdapter = {
  id: "grok-session-folder",
  provider: "grok",
  displayName: "Grok session folder",
  stable: true,
  defaultRoot: () => homePath(".grok"),
  read: async (options) => {
    const root = options.roots?.grok ?? grokAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: grokAdapter.id,
            provider: "grok",
            status: "no_data_found",
            message: "Grok root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }
    const sessionsRoot = join(root, "sessions");
    const files = collectFiles(
      sessionsRoot,
      (path) => path.endsWith("chat_history.jsonl"),
      options.limit,
    );
    const rootRecord = sourceRoot("grok", grokAdapter.id, sessionsRoot, options.machine, options.now);
    const sessions = files.map((chatPath) => {
      const sessionDir = dirname(chatPath);
      const sessionId = basename(sessionDir);
      const projectKey = basename(dirname(sessionDir));
      const projectPath = decodeProjectPath(projectKey);
      const summary = readJsonFile(join(sessionDir, "summary.json"));
      const chatLines = readJsonLines(chatPath);
      const eventLines = readJsonLines(join(sessionDir, "events.jsonl"));
      const events = [
        ...chatLines.map(({ value, lineNumber }, index) => {
          const record =
            typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : {};
          const type = typeof record.type === "string" ? record.type : "message";
          const nativeEventId =
            typeof record.id === "string" ? record.id : undefined;
          return {
            id: eventIdFor("grok", chatPath, index, nativeEventId ?? lineNumber),
            nativeEventId,
            sequence: index,
            role: roleFrom(record.type),
            kind: type === "tool_result" ? ("tool_result" as const) : ("message" as const),
            contentText: compactText(record.content),
            content: record.content,
            rawReference: { sourcePath: chatPath, line: lineNumber, nativeType: type },
            raw: value,
          };
        }),
        ...eventLines.map(({ value, lineNumber }, index) => {
          const record =
            typeof value === "object" && value !== null
              ? (value as Record<string, unknown>)
              : {};
          const type = typeof record.type === "string" ? record.type : "event";
          const eventPath = join(sessionDir, "events.jsonl");
          const nativeEventId =
            typeof record.id === "string" ? record.id : undefined;
          return {
            id: eventIdFor("grok", eventPath, index, nativeEventId ?? lineNumber),
            nativeEventId,
            sequence: chatLines.length + index,
            timestamp: typeof record.ts === "string" ? record.ts : undefined,
            role: "unknown" as const,
            kind: type.includes("tool")
              ? type.includes("completed")
                ? ("tool_result" as const)
                : ("tool_call" as const)
              : ("lifecycle" as const),
            contentText: compactText(record),
            content: record,
            rawReference: {
              sourcePath: eventPath,
              line: lineNumber,
              nativeType: type,
            },
            raw: value,
          };
        }),
      ];
      return buildSession({
        provider: "grok",
        agentName: "grok-build",
        machine: options.machine,
        nativeSessionId: sessionId,
        nativeProjectKey: projectKey,
        title:
          typeof (summary as Record<string, unknown> | undefined)?.title === "string"
            ? ((summary as Record<string, unknown>).title as string)
            : undefined,
        sourceRoot: sessionsRoot,
        sourcePath: sessionDir,
        projectPath,
        rawMetadata: summary,
        events,
      });
    });

    return {
      sourceRoots: [rootRecord],
      sessions,
      diagnostics: [
        {
          adapterId: grokAdapter.id,
          provider: "grok",
          status: sessions.length > 0 ? "available" : "no_data_found",
          rootPath: sessionsRoot,
          message: `Discovered ${sessions.length} Grok session(s).`,
        },
      ],
    };
  },
};
