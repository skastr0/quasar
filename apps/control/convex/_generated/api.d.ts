/* eslint-disable */
import type * as http from "../http.js";
import type * as httpAuth from "../httpAuth.js";
import type * as quasar from "../quasar.js";
import type * as quasarRag from "../quasarRag.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  httpAuth: typeof httpAuth;
  quasar: typeof quasar;
  quasarRag: typeof quasarRag;
}>;

export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
export declare const components: {
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
};
