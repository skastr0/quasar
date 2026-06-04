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
  readJsonLines,
  roleFrom,
  sourceRoot,
  type NativeValue,
} from "./common";

export const codexAdapter: SessionAdapter = {
  id: "codex-local-jsonl",
  provider: "codex",
  displayName: "Codex local JSONL",
  stable: true,
  defaultRoot: () => process.env.CODEX_HOME ?? homePath(".codex"),
  read: async (options) => {
    const root = options.roots?.codex ?? codexAdapter.defaultRoot();
    if (root === undefined || !existsSync(root)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: codexAdapter.id,
            provider: "codex",
            status: "no_data_found",
            message: "Codex root was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }

    const sessionsRoot = join(root, "sessions");
    const files = collectFiles(
      sessionsRoot,
      (path) => /rollout-.*\.jsonl$/.test(path),
      options.limit,
    );
    const rootRecord = sourceRoot("codex", codexAdapter.id, sessionsRoot, options.machine, options.now);
    const sessions = files.map((path) => {
      const lines = readJsonLines(path);
      const sessionMeta = lines.find(
        ({ value }) =>
          typeof value === "object" &&
          value !== null &&
          (value as Record<string, unknown>).type === "session_meta",
      )?.value as Record<string, unknown> | undefined;
      const payload =
        sessionMeta?.payload !== null && typeof sessionMeta?.payload === "object"
          ? (sessionMeta.payload as Record<string, unknown>)
          : undefined;
      const projectPath =
        typeof payload?.cwd === "string"
          ? payload.cwd
          : typeof payload?.working_dir === "string"
            ? payload.working_dir
            : undefined;

      const events = lines.map(({ value, lineNumber }, index) => {
        const record =
          typeof value === "object" && value !== null
            ? (value as Record<string, unknown>)
            : {};
        const nativeType = typeof record.type === "string" ? record.type : "unknown";
        const payloadValue = record.payload;
        const payloadRecord =
          payloadValue !== null && typeof payloadValue === "object"
            ? (payloadValue as Record<string, unknown>)
            : {};
        const role = roleFrom(
          typeof payloadRecord.role === "string" ? payloadRecord.role : undefined,
        );
        const nativeEventId =
          typeof payloadRecord.id === "string"
            ? payloadRecord.id
            : typeof record.id === "string"
              ? record.id
              : undefined;
        return {
          id: eventIdFor("codex", path, index, nativeEventId ?? lineNumber),
          nativeEventId,
          sequence: index,
          timestamp:
            typeof record.timestamp === "string" ? record.timestamp : undefined,
          role,
          kind: kindFromNative(nativeType),
          contentText: compactText(payloadValue as NativeValue | undefined),
          content: payloadValue,
          rawReference: { sourcePath: path, line: lineNumber, nativeType },
          raw: value,
        };
      });

      return buildSession({
        provider: "codex",
        agentName: "codex",
        machine: options.machine,
        nativeSessionId: nativeSessionIdFromPath(path),
        nativeProjectKey: projectPath,
        sourceRoot: sessionsRoot,
        sourcePath: path,
        projectPath,
        rawMetadata: sessionMeta as NativeValue | undefined,
        events,
      });
    });

    return {
      sourceRoots: [rootRecord],
      sessions,
      diagnostics: [
        {
          adapterId: codexAdapter.id,
          provider: "codex",
          status: sessions.length > 0 ? "available" : "no_data_found",
          rootPath: sessionsRoot,
          message: `Discovered ${sessions.length} Codex session(s).`,
        },
      ],
    };
  },
};
