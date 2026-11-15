/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters_storage from "../adapters/storage.js";
import type * as annotation_state from "../annotation_state.js";
import type * as annotations from "../annotations.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as crons from "../crons.js";
import type * as customer_validation from "../customer_validation.js";
import type * as customers from "../customers.js";
import type * as domain_media from "../domain/media.js";
import type * as domain_media_jobs from "../domain/media_jobs.js";
import type * as domain_operation from "../domain/operation.js";
import type * as domain_operations from "../domain/operations.js";
import type * as domain_projects from "../domain/projects.js";
import type * as domain_reads from "../domain/reads.js";
import type * as domain_requests from "../domain/requests.js";
import type * as domain_tags from "../domain/tags.js";
import type * as domain_tickets from "../domain/tickets.js";
import type * as functions from "../functions.js";
import type * as local_fixtures from "../local_fixtures.js";
import type * as local_smoke from "../local_smoke.js";
import type * as login_guard from "../login_guard.js";
import type * as media_job_actions from "../media_job_actions.js";
import type * as password from "../password.js";
import type * as projects from "../projects.js";
import type * as retention from "../retention.js";
import type * as seed from "../seed.js";
import type * as session_auth from "../session_auth.js";
import type * as ticket_requests from "../ticket_requests.js";
import type * as tickets from "../tickets.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/storage": typeof adapters_storage;
  annotation_state: typeof annotation_state;
  annotations: typeof annotations;
  auth: typeof auth;
  authz: typeof authz;
  crons: typeof crons;
  customer_validation: typeof customer_validation;
  customers: typeof customers;
  "domain/media": typeof domain_media;
  "domain/media_jobs": typeof domain_media_jobs;
  "domain/operation": typeof domain_operation;
  "domain/operations": typeof domain_operations;
  "domain/projects": typeof domain_projects;
  "domain/reads": typeof domain_reads;
  "domain/requests": typeof domain_requests;
  "domain/tags": typeof domain_tags;
  "domain/tickets": typeof domain_tickets;
  functions: typeof functions;
  local_fixtures: typeof local_fixtures;
  local_smoke: typeof local_smoke;
  login_guard: typeof login_guard;
  media_job_actions: typeof media_job_actions;
  password: typeof password;
  projects: typeof projects;
  retention: typeof retention;
  seed: typeof seed;
  session_auth: typeof session_auth;
  ticket_requests: typeof ticket_requests;
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
