import { existsSync } from "node:fs";

import { claudeAdapter } from "./claude";
import { codexAdapter } from "./codex";
import { grokAdapter } from "./grok";
import { opencodeAdapter } from "./opencode";
import type { AdapterDiscoverOptions, AdapterReadResult, SessionAdapter } from "./types";
import type { Provider } from "../schemas";
import { homePath } from "./common";

const unsupportedAdapter = (
  provider: Provider,
  displayName: string,
  root: () => string | undefined,
): SessionAdapter => ({
  id: `${provider}-diagnostic`,
  provider,
  displayName,
  stable: false,
  defaultRoot: root,
  read: async (options) => {
    const rootPath = options.roots?.[provider] ?? root();
    const present = rootPath !== undefined && existsSync(rootPath);
    return {
      sourceRoots: [],
      sessions: [],
      diagnostics: [
        {
          adapterId: `${provider}-diagnostic`,
          provider,
          status: present ? "unsupported" : "no_data_found",
          ...(rootPath !== undefined ? { rootPath } : {}),
          message: present
            ? `${displayName} has a registry entry, but no stable v1 parser yet.`
            : `${displayName} root was not found.`,
        },
      ],
    };
  },
});

export const stableAdapters = [
  codexAdapter,
  claudeAdapter,
  opencodeAdapter,
  grokAdapter,
] as const;

export const experimentalAdapters = [
  unsupportedAdapter("amp", "Amp", () => homePath(".local/share/amp")),
  unsupportedAdapter("pi", "Pi", () => homePath(".pi/agent/sessions")),
  unsupportedAdapter("kimi", "Kimi Code", () => process.env.KIMI_CODE_HOME ?? homePath(".kimi-code")),
  unsupportedAdapter("droid", "Factory Droid", () => homePath(".factory")),
  unsupportedAdapter("antigravity", "Antigravity", () => homePath(".gemini/antigravity")),
  unsupportedAdapter("cursor", "Cursor", () =>
    homePath("Library/Application Support/Cursor/User"),
  ),
] as const;

export const allAdapters: readonly SessionAdapter[] = [
  ...stableAdapters,
  ...experimentalAdapters,
];

export const adaptersByProvider = new Map(
  allAdapters.map((adapter) => [adapter.provider, adapter]),
);

export const readAdapters = async (
  adapters: readonly SessionAdapter[],
  options: AdapterDiscoverOptions,
): Promise<AdapterReadResult> => {
  const results = await Promise.all(adapters.map((adapter) => adapter.read(options)));
  return {
    sourceRoots: results.flatMap((result) => result.sourceRoots),
    sessions: results.flatMap((result) => result.sessions),
    diagnostics: results.flatMap((result) => result.diagnostics),
  };
};
