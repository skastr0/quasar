/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ingestQueries from "../ingestQueries.js";
import type * as quasar from "../quasar.js";
import type * as search from "../search.js";
import type * as searchData from "../searchData.js";
import type * as searchIndex from "../searchIndex.js";
import type * as searchPlan from "../searchPlan.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ingestQueries: typeof ingestQueries;
  quasar: typeof quasar;
  search: typeof search;
  searchData: typeof searchData;
  searchIndex: typeof searchIndex;
  searchPlan: typeof searchPlan;
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

export declare const components: {};
