import { Command } from "@effect/cli";
import { Effect } from "effect";

import { allAdapters } from "@quasar/core";

import { CLI_NAME, CLI_VERSION } from "../constants";
import { executeJsonCommand } from "../output";

const commandCapabilities = [
  "doctor",
  "capabilities",
  "schema list|show",
  "examples list|show",
  "sources discover",
  "projects list|alias",
  "ingest validate|plan|run|inspect|wait|events",
  "search text|semantic|fusion",
  "sessions list|read",
  "tool-calls list|read",
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
      server: {
        requires_authentication: true,
        accepts_client_embeddings: false,
      },
    }),
  ),
);
