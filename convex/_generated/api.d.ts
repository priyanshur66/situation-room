/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as dashboardState from "../dashboardState.js";
import type * as dashboards from "../dashboards.js";
import type * as delegation from "../delegation.js";
import type * as paymentState from "../paymentState.js";
import type * as paymentWorker from "../paymentWorker.js";
import type * as paymentWorkerState from "../paymentWorkerState.js";
import type * as payments from "../payments.js";
import type * as room from "../room.js";
import type * as state from "../state.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  dashboardState: typeof dashboardState;
  dashboards: typeof dashboards;
  delegation: typeof delegation;
  paymentState: typeof paymentState;
  paymentWorker: typeof paymentWorker;
  paymentWorkerState: typeof paymentWorkerState;
  payments: typeof payments;
  room: typeof room;
  state: typeof state;
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
