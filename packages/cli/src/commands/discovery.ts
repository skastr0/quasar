import { Command } from "@effect/cli";
import { Effect } from "effect";

import { allAdapters } from "@skastr0/quasar-core";

import { CLI_NAME, CLI_VERSION } from "../constants";
import { executeJsonCommand } from "../output";

const commandCapabilities = [
  "doctor",
  "capabilities",
  "schema list|show",
  "examples list|show",
  "sources discover",
  "ingest --provider <p|all> [--root <dir>] [--limit <n>] [--force]",
  "daemon install [--interval-seconds 300] [--binary <path>]",
  "daemon uninstall",
  "daemon status",
  "maintain [--create-indexes] [--create-vector-index] [--replace-indexes] [--optimize] [--cleanup-older-than-ms <n>]",
  "projects list",
  "sessions list [--project <key>] [--provider <provider>] [--limit <n>]",
  "sessions read <sessionId> [--limit <n>]",
  "tool-calls list --session <sessionId> [--limit <n>]",
  "tool-calls list --project <key> [--provider <provider>] [--tool-name <name>] [--limit <n>]",
  "tool-calls read <sessionId>#<seq>",
];

export const doctorCommand = Command.make("doctor", {}, () =>
  executeJsonCommand(
    "doctor",
    Effect.succeed({
      cli: { name: CLI_NAME, version: CLI_VERSION },
      runtime: { name: "bun", version: Bun.version },
      status: "ok",
      checks: [
        { name: "runtime.bun", ok: true, details: { version: Bun.version } },
        {
          name: "history_safety",
          ok: true,
          details: { behavior: "read-only extraction; no native history writes" },
        },
      ],
    }),
  ),
);

export const capabilitiesCommand = Command.make("capabilities", {}, () =>
  executeJsonCommand(
    "capabilities",
    Effect.succeed({
      protocol_version: "quasar-cli/v1",
      commands: commandCapabilities,
      adapters: allAdapters.map((adapter) => ({
        adapter_id: adapter.id,
        provider: adapter.provider,
        display_name: adapter.displayName,
        stable: adapter.stable,
        default_root: adapter.defaultRoot(),
      })),
    }),
  ),
);
