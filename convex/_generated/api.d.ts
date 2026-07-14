/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as annotation_state from "../annotation_state.js";
import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as feedback from "../feedback.js";
import type * as feedback_state from "../feedback_state.js";
import type * as ticket_numbers from "../ticket_numbers.js";
import type * as upload_cleanup from "../upload_cleanup.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  annotation_state: typeof annotation_state;
  auth: typeof auth;
  crons: typeof crons;
  feedback: typeof feedback;
  feedback_state: typeof feedback_state;
  ticket_numbers: typeof ticket_numbers;
  upload_cleanup: typeof upload_cleanup;
  uploads: typeof uploads;
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
