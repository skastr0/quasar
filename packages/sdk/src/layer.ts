import { FetchHttpClient } from "@effect/platform";
import { Layer } from "effect";
import { QuasarClientLive, QuasarClientTag } from "./client.js";
import { QuasarConfigLive } from "./config.js";

/** Convenience layer: QuasarClientLive provided with QuasarConfigLive +
 * FetchHttpClient.layer, fully resolved (no remaining requirements). This is
 * what vellum merges into its RootLayer.
 *
 * The pieces (QuasarClientLive, QuasarConfigLive) stay exported from the SDK
 * so a consumer that needs a different transport — the TUI's curl-file-poll
 * workaround for opentui starving libuv fetch bodies — can provide its own
 * HttpClient.HttpClient layer instead of FetchHttpClient.layer and reuse the
 * same client + schemas. */
export const QuasarSdkLive: Layer.Layer<QuasarClientTag, never, never> = QuasarClientLive.pipe(
  Layer.provide([QuasarConfigLive, FetchHttpClient.layer]),
);
