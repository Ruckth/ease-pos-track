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
import type * as annotations from "../annotations.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as crons from "../crons.js";
import type * as customer_validation from "../customer_validation.js";
import type * as customers from "../customers.js";
import type * as domain_operation from "../domain/operation.js";
import type * as domain_operations from "../domain/operations.js";
import type * as domain_projects from "../domain/projects.js";
import type * as domain_tickets from "../domain/tickets.js";
import type * as functions from "../functions.js";
import type * as local_smoke from "../local_smoke.js";
import type * as login_guard from "../login_guard.js";
import type * as password from "../password.js";
import type * as projects from "../projects.js";
import type * as seed from "../seed.js";
import type * as session_auth from "../session_auth.js";
import type * as ticket_numbers from "../ticket_numbers.js";
import type * as ticket_requests from "../ticket_requests.js";
import type * as ticket_state from "../ticket_state.js";
import type * as tickets from "../tickets.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  annotation_state: typeof annotation_state;
  annotations: typeof annotations;
  auth: typeof auth;
  authz: typeof authz;
  crons: typeof crons;
  customer_validation: typeof customer_validation;
  customers: typeof customers;
  "domain/operation": typeof domain_operation;
  "domain/operations": typeof domain_operations;
  "domain/projects": typeof domain_projects;
  "domain/tickets": typeof domain_tickets;
  functions: typeof functions;
  local_smoke: typeof local_smoke;
  login_guard: typeof login_guard;
  password: typeof password;
  projects: typeof projects;
  seed: typeof seed;
  session_auth: typeof session_auth;
  ticket_numbers: typeof ticket_numbers;
  ticket_requests: typeof ticket_requests;
  ticket_state: typeof ticket_state;
  tickets: typeof tickets;
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
