import { existsSync } from "node:fs";
import { join } from "node:path";

import type { SessionAdapter } from "./types";
import type { SessionRole, ToolCall } from "../schemas";
import {
  buildSession,
  compactText,
  eventIdFor,
  homePath,
  readJsonFile,
  sourceRoot,
} from "./common";

const maybeDatabase = async (path: string) => {
  try {
    const { Database } = await import("bun:sqlite");
    return new Database(path, { readonly: true });
  } catch {
    return undefined;
  }
};

const toolNameFromPart = (part: unknown) => {
  if (part === null || typeof part !== "object") return undefined;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (!type.includes("tool") && record.tool === undefined && record.toolName === undefined) {
    return undefined;
  }
  if (typeof record.toolName === "string") return record.toolName;
  if (typeof record.tool === "string") return record.tool;
  if (typeof record.name === "string") return record.name;
  const nested = record.function ?? record.call ?? record.metadata;
  if (nested !== null && typeof nested === "object") {
    const nestedRecord = nested as Record<string, unknown>;
    if (typeof nestedRecord.name === "string") return nestedRecord.name;
  }
  return "opencode-tool";
};

export const opencodeAdapter: SessionAdapter = {
  id: "opencode-sqlite",
  provider: "opencode",
  displayName: "OpenCode SQLite",
  stable: true,
  defaultRoot: () => homePath(".local/share/opencode"),
  read: async (options) => {
    const root = options.roots?.opencode ?? opencodeAdapter.defaultRoot();
    const dbPath = root === undefined ? undefined : join(root, "opencode.db");
    if (root === undefined || dbPath === undefined || !existsSync(dbPath)) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: opencodeAdapter.id,
            provider: "opencode",
            status: "no_data_found",
            message: "OpenCode database was not found.",
            ...(root !== undefined ? { rootPath: root } : {}),
          },
        ],
      };
    }

    const db = await maybeDatabase(dbPath);
    if (db === undefined) {
      return {
        sourceRoots: [],
        sessions: [],
        diagnostics: [
          {
            adapterId: opencodeAdapter.id,
            provider: "opencode",
            status: "unsupported",
            rootPath: dbPath,
            message: "OpenCode SQLite import requires Bun's sqlite runtime.",
          },
        ],
      };
    }

    const rows = db
      .query(
        "select id, title, directory, path, time_created, time_updated from session order by time_updated desc limit ?",
      )
      .all(options.limit ?? 500) as {
      id: string;
      title: string;
      directory: string;
      path: string | null;
      time_created: number;
      time_updated: number;
    }[];

    const sessions = rows.map((sessionRow) => {
      const messages = db
        .query(
          "select id, time_created, data from message where session_id = ? order by time_created, id",
        )
        .all(sessionRow.id) as { id: string; time_created: number; data: string }[];
      const parts = db
        .query(
          "select id, message_id, time_created, data from part where session_id = ? order by time_created, id",
        )
        .all(sessionRow.id) as {
        id: string;
        message_id: string;
        time_created: number;
        data: string;
      }[];
      const partsByMessage = new Map<string, unknown[]>();
      for (const part of parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        try {
          list.push(JSON.parse(part.data));
        } catch {
          list.push(part.data);
        }
        partsByMessage.set(part.message_id, list);
      }
      const toolCalls: Omit<
        ToolCall,
        "sessionId" | "machineId" | "provider" | "agentName" | "projectIdentityKey"
      >[] = [];
      const events = messages.map((message, index) => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(message.data) as Record<string, unknown>;
        } catch {
          data = { raw: message.data };
        }
        const content = {
          message: data,
          parts: partsByMessage.get(message.id) ?? [],
        };
        const eventRole: SessionRole =
          data.role === "assistant" || data.role === "user"
            ? data.role
            : "unknown";
        const eventId = eventIdFor("opencode", dbPath, index, message.id);
        for (const [partIndex, part] of content.parts.entries()) {
          const toolName = toolNameFromPart(part);
          if (toolName === undefined) continue;
          toolCalls.push({
            id: `opencode:tool:${message.id}:${partIndex}`,
            eventId,
            toolName,
            input: part,
            raw: part,
          });
        }
        return {
          id: eventId,
          nativeEventId: message.id,
          sequence: index,
          timestamp: new Date(message.time_created).toISOString(),
          role: eventRole,
          kind: "message" as const,
          contentText: compactText(content),
          content,
          rawReference: {
            sourcePath: dbPath,
            table: "message",
            rowId: message.id,
            nativeType: "message",
          },
          raw: content,
        };
      });
      return buildSession({
        provider: "opencode",
        agentName: "opencode",
        machine: options.machine,
        nativeSessionId: sessionRow.id,
        nativeProjectKey: sessionRow.directory,
        title: sessionRow.title,
        sourceRoot: root,
        sourcePath: dbPath,
        projectPath: sessionRow.path ?? sessionRow.directory,
        rawMetadata: sessionRow,
        events,
        toolCalls,
      });
    });
    db.close();

    return {
      sourceRoots: [sourceRoot("opencode", opencodeAdapter.id, root, options.machine, options.now)],
      sessions,
      diagnostics: [
        {
          adapterId: opencodeAdapter.id,
          provider: "opencode",
          status: sessions.length > 0 ? "available" : "no_data_found",
          rootPath: dbPath,
          message: `Discovered ${sessions.length} OpenCode session(s).`,
        },
      ],
    };
  },
};
