// Public API for @skastr0/quasar-sdk

// Row/type shapes consumers actually type against (vellum's adapters and the
// CLI/TUI — see packages/cli/src/cli.ts, packages/cli/src/tui/quasar-client.ts).
// Types only: the runtime Schema validators (and transport-internal envelope
// shapes like Envelope/SuccessEnvelope/ErrorEnvelope/ServerError/MessageRole)
// stay private to client.ts's decode path — no consumer imports them, and
// decoding is something only the SDK's own transport does.
export type {
  Provider,
  SearchMode,
  IngestRunStatus,
  ProjectRow,
  SessionRow,
  MessageRow,
  ToolCallRow,
  IngestRunRow,
  SearchHit,
} from "./schema.js";

// Errors
export {
  QuasarConfigError,
  QuasarTransportError,
  QuasarServerError,
  QuasarDecodeError,
  type QuasarError,
} from "./errors.js";

// Config
export {
  QuasarConfig,
  QuasarConfigTag,
  QuasarConfigLive,
  makeQuasarConfig,
  defaultClientConfigPath,
  loadClientConfig,
  type QuasarConfig as QuasarConfigType,
} from "./config.js";

// Client
export {
  QuasarClient,
  QuasarClientTag,
  QuasarClientLive,
  type QuasarClientService,
  type HealthReport,
  type ListProjectsOptions,
  type ListSessionsOptions,
  type ReadMessagesOptions,
  type ListToolCallsOptions,
  type ListIngestRunsOptions,
  type SearchOptions,
} from "./client.js";

// Layers
export { QuasarSdkLive } from "./layer.js";
