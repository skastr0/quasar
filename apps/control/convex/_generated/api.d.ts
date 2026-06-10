/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as httpAuth from "../httpAuth.js";
import type * as quasar from "../quasar.js";
import type * as quasarApiPaths from "../quasarApiPaths.js";
import type * as quasarDomainSchemas from "../quasarDomainSchemas.js";
import type * as quasarEmbeddingReadiness from "../quasarEmbeddingReadiness.js";
import type * as quasarProjectHandlers from "../quasarProjectHandlers.js";
import type * as quasarRag from "../quasarRag.js";
import type * as quasarRagSync from "../quasarRagSync.js";
import type * as quasarReadHandlers from "../quasarReadHandlers.js";
import type * as quasarRecordIngest from "../quasarRecordIngest.js";
import type * as quasarSearchDocuments from "../quasarSearchDocuments.js";
import type * as quasarSearchHandlers from "../quasarSearchHandlers.js";
import type * as quasarSearchTypes from "../quasarSearchTypes.js";
import type * as quasarText from "../quasarText.js";
import type * as quasarToolExtraction from "../quasarToolExtraction.js";
import type * as quasarValues from "../quasarValues.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  httpAuth: typeof httpAuth;
  quasar: typeof quasar;
  quasarApiPaths: typeof quasarApiPaths;
  quasarDomainSchemas: typeof quasarDomainSchemas;
  quasarEmbeddingReadiness: typeof quasarEmbeddingReadiness;
  quasarProjectHandlers: typeof quasarProjectHandlers;
  quasarRag: typeof quasarRag;
  quasarRagSync: typeof quasarRagSync;
  quasarReadHandlers: typeof quasarReadHandlers;
  quasarRecordIngest: typeof quasarRecordIngest;
  quasarSearchDocuments: typeof quasarSearchDocuments;
  quasarSearchHandlers: typeof quasarSearchHandlers;
  quasarSearchTypes: typeof quasarSearchTypes;
  quasarText: typeof quasarText;
  quasarToolExtraction: typeof quasarToolExtraction;
  quasarValues: typeof quasarValues;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  rag: import("@convex-dev/rag/_generated/component.js").ComponentApi<"rag">;
  workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi<"workpool">;
};
