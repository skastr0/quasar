import { Layer, ManagedRuntime } from "effect";

import { LocalServerConfigLive } from "./config";
import { makeEmbeddingsLayer } from "./embeddings";
import { DerivedSearchLive } from "./search";
import { DurableQueueLive, IngestCoordinatorLive } from "./services";
import { makeLocalStoreLayer } from "./store";
import { WorkerSupervisorLive } from "./workers";

const DataQueueLayer = Layer.mergeAll(
  LocalServerConfigLive,
  makeLocalStoreLayer(),
  DurableQueueLive,
  IngestCoordinatorLive,
);

const DataSearchLayer = DerivedSearchLive.pipe(Layer.provideMerge(DataQueueLayer));
const WithEmbeddingsLayer = makeEmbeddingsLayer().pipe(Layer.provideMerge(DataSearchLayer));

export const AppLayer = WorkerSupervisorLive.pipe(Layer.provideMerge(WithEmbeddingsLayer));

export const AppRuntime = ManagedRuntime.make(AppLayer);
