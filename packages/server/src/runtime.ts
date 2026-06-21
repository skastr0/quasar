import { LanceDb, makeLanceDbLayer } from "@skastr0/quasar-search";
import { Layer, ManagedRuntime } from "effect";

import { LocalServerConfigLive } from "./config";
import { makeEmbeddingsLayer } from "./embeddings";
import { SearchMaintenanceLive } from "./maintenance";
import { DerivedSearchLive } from "./search";
import { DurableQueueLive, IngestCoordinatorLive } from "./services";
import { makeLocalStoreLayer } from "./store";
import { WorkerSupervisorLive } from "./workers";

const DataQueueLayer = Layer.mergeAll(
  LocalServerConfigLive,
  makeLocalStoreLayer(),
  makeLanceDbLayer(),
  DurableQueueLive,
  IngestCoordinatorLive,
);

const DataSearchLayer = DerivedSearchLive.pipe(Layer.provideMerge(DataQueueLayer));
const WithEmbeddingsLayer = makeEmbeddingsLayer().pipe(Layer.provideMerge(DataSearchLayer));
const WithMaintenanceLayer = SearchMaintenanceLive.pipe(Layer.provideMerge(WithEmbeddingsLayer));

export const AppLayer = WorkerSupervisorLive.pipe(Layer.provideMerge(WithMaintenanceLayer));

export const AppRuntime = ManagedRuntime.make(AppLayer);

export type AppServices = LanceDb;
