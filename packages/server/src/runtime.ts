import { Layer, ManagedRuntime } from "effect";

import { LocalServerConfigLive } from "./config";
import { makeEmbeddingsLayer } from "./embeddings";
import { DerivedSearchLive } from "./search";
import { DurableQueueLive, IngestCoordinatorLive } from "./services";
import { makeLocalStoreLayer } from "./store";
import { makeVectorMatrixLayer } from "./vectorMatrix";
import { WorkerSupervisorLive } from "./workers";

const DataQueueLayer = Layer.mergeAll(
  LocalServerConfigLive,
  makeLocalStoreLayer(),
  DurableQueueLive,
  IngestCoordinatorLive,
);

const DataSearchLayer = DerivedSearchLive.pipe(Layer.provideMerge(DataQueueLayer));
const WithEmbeddingsLayer = makeEmbeddingsLayer().pipe(Layer.provideMerge(DataSearchLayer));
// The resident matrix registers the store's vector-write listener at layer
// init, so it must build on the same LocalStore instance the embeddings
// write through — provideMerge keeps one shared store underneath both.
const WithVectorMatrixLayer = makeVectorMatrixLayer().pipe(Layer.provideMerge(WithEmbeddingsLayer));

export const AppLayer = WorkerSupervisorLive.pipe(Layer.provideMerge(WithVectorMatrixLayer));

export const AppRuntime = ManagedRuntime.make(AppLayer);
