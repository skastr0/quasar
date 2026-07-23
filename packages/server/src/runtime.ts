import { FetchHttpClient } from "@effect/platform";
import * as Otlp from "@effect/opentelemetry/Otlp";
import { Effect, Layer, Logger, ManagedRuntime } from "effect";

import { LocalServerConfigLive } from "./config";
import { makeEmbeddingsLayer } from "./embeddings";
import { DurableQueueLive, IngestCoordinatorLive } from "./services";
import { makeLocalStoreLayer } from "./store";
import { makeVectorMatrixLayer } from "./vectorMatrix";
import { WorkerSupervisorLive } from "./workers";

const DataQueueLayer = Layer.mergeAll(
  LocalServerConfigLive,
  makeLocalStoreLayer(),
  DurableQueueLive,
);

// The coordinator reads lifecycle state through the same LocalStore instance
// as the HTTP handlers; provideMerge keeps that store shared rather than
// opening a second connection solely for status.
const WithIngestLayer = IngestCoordinatorLive.pipe(Layer.provideMerge(DataQueueLayer));
const WithEmbeddingsLayer = makeEmbeddingsLayer().pipe(Layer.provideMerge(WithIngestLayer));
// The resident matrix registers the store's vector-write listener at layer
// init, so it must build on the same LocalStore instance the embeddings
// write through — provideMerge keeps one shared store underneath both.
const WithVectorMatrixLayer = makeVectorMatrixLayer().pipe(Layer.provideMerge(WithEmbeddingsLayer));

export const ObservabilityLayer = Layer.unwrapEffect(
  Effect.sync(() => {
    const baseUrl = process.env.QUASAR_OTLP_BASE_URL?.trim() || undefined;
    const otlpLayer = baseUrl === undefined
      ? Layer.empty
      : Otlp.layerJson({ baseUrl, resource: { serviceName: "quasar-server" } }).pipe(
          Layer.provide(FetchHttpClient.layer),
        );

    return Layer.mergeAll(Logger.json, otlpLayer);
  }),
);

// Observability is the base, not a sibling: layer-construction / forkScoped
// diagnostics from the service graph must run under Logger.json (and OTLP
// when configured). provideMerge builds Observability first, then the services.
export const AppLayer = WorkerSupervisorLive.pipe(
  Layer.provideMerge(WithVectorMatrixLayer),
  Layer.provideMerge(ObservabilityLayer),
);

export const AppRuntime = ManagedRuntime.make(AppLayer);
