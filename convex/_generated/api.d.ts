/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as adapters_line from "../adapters/line.js";
import type * as adapters_storage from "../adapters/storage.js";
import type * as annotation_state from "../annotation_state.js";
import type * as annotations from "../annotations.js";
import type * as auth from "../auth.js";
import type * as authz from "../authz.js";
import type * as clerk_profile from "../clerk_profile.js";
import type * as conversations from "../conversations.js";
import type * as crons from "../crons.js";
import type * as domain_conversation from "../domain/conversation.js";
import type * as domain_identity from "../domain/identity.js";
import type * as domain_inbox from "../domain/inbox.js";
import type * as domain_line from "../domain/line.js";
import type * as domain_media from "../domain/media.js";
import type * as domain_media_jobs from "../domain/media_jobs.js";
import type * as domain_operation from "../domain/operation.js";
import type * as domain_operations from "../domain/operations.js";
import type * as domain_pages from "../domain/pages.js";
import type * as domain_projects from "../domain/projects.js";
import type * as domain_reads from "../domain/reads.js";
import type * as domain_requests from "../domain/requests.js";
import type * as domain_routing_identity from "../domain/routing_identity.js";
import type * as domain_routing_policy from "../domain/routing_policy.js";
import type * as domain_routing_suggestions from "../domain/routing_suggestions.js";
import type * as domain_staff_inbox from "../domain/staff_inbox.js";
import type * as domain_t3_keys from "../domain/t3_keys.js";
import type * as domain_tags from "../domain/tags.js";
import type * as domain_ticket_assignment from "../domain/ticket_assignment.js";
import type * as domain_tickets from "../domain/tickets.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as identity from "../identity.js";
import type * as identity_recovery_access from "../identity_recovery_access.js";
import type * as identity_restore from "../identity_restore.js";
import type * as identity_rules from "../identity_rules.js";
import type * as identity_staff_recovery from "../identity_staff_recovery.js";
import type * as image_chunks from "../image_chunks.js";
import type * as image_transfer from "../image_transfer.js";
import type * as inbox from "../inbox.js";
import type * as line from "../line.js";
import type * as line_crypto from "../line_crypto.js";
import type * as line_jobs from "../line_jobs.js";
import type * as line_local from "../line_local.js";
import type * as line_schema from "../line_schema.js";
import type * as line_webhook from "../line_webhook.js";
import type * as local_fixtures from "../local_fixtures.js";
import type * as local_identity from "../local_identity.js";
import type * as local_smoke from "../local_smoke.js";
import type * as login_guard from "../login_guard.js";
import type * as media_job_actions from "../media_job_actions.js";
import type * as page_http from "../page_http.js";
import type * as page_image_actions from "../page_image_actions.js";
import type * as pages from "../pages.js";
import type * as pilot_access from "../pilot_access.js";
import type * as pilot_release from "../pilot_release.js";
import type * as pilot_retention from "../pilot_retention.js";
import type * as projects from "../projects.js";
import type * as retention from "../retention.js";
import type * as routing_schema from "../routing_schema.js";
import type * as seed from "../seed.js";
import type * as session_auth from "../session_auth.js";
import type * as staff_inbox from "../staff_inbox.js";
import type * as t3_config from "../t3_config.js";
import type * as t3_doctor from "../t3_doctor.js";
import type * as t3_identity from "../t3_identity.js";
import type * as t3_keys from "../t3_keys.js";
import type * as tag_rules from "../tag_rules.js";
import type * as ticket_requests from "../ticket_requests.js";
import type * as ticket_routing from "../ticket_routing.js";
import type * as tickets from "../tickets.js";
import type * as uploads from "../uploads.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "adapters/line": typeof adapters_line;
  "adapters/storage": typeof adapters_storage;
  annotation_state: typeof annotation_state;
  annotations: typeof annotations;
  auth: typeof auth;
  authz: typeof authz;
  clerk_profile: typeof clerk_profile;
  conversations: typeof conversations;
  crons: typeof crons;
  "domain/conversation": typeof domain_conversation;
  "domain/identity": typeof domain_identity;
  "domain/inbox": typeof domain_inbox;
  "domain/line": typeof domain_line;
  "domain/media": typeof domain_media;
  "domain/media_jobs": typeof domain_media_jobs;
  "domain/operation": typeof domain_operation;
  "domain/operations": typeof domain_operations;
  "domain/pages": typeof domain_pages;
  "domain/projects": typeof domain_projects;
  "domain/reads": typeof domain_reads;
  "domain/requests": typeof domain_requests;
  "domain/routing_identity": typeof domain_routing_identity;
  "domain/routing_policy": typeof domain_routing_policy;
  "domain/routing_suggestions": typeof domain_routing_suggestions;
  "domain/staff_inbox": typeof domain_staff_inbox;
  "domain/t3_keys": typeof domain_t3_keys;
  "domain/tags": typeof domain_tags;
  "domain/ticket_assignment": typeof domain_ticket_assignment;
  "domain/tickets": typeof domain_tickets;
  functions: typeof functions;
  http: typeof http;
  identity: typeof identity;
  identity_recovery_access: typeof identity_recovery_access;
  identity_restore: typeof identity_restore;
  identity_rules: typeof identity_rules;
  identity_staff_recovery: typeof identity_staff_recovery;
  image_chunks: typeof image_chunks;
  image_transfer: typeof image_transfer;
  inbox: typeof inbox;
  line: typeof line;
  line_crypto: typeof line_crypto;
  line_jobs: typeof line_jobs;
  line_local: typeof line_local;
  line_schema: typeof line_schema;
  line_webhook: typeof line_webhook;
  local_fixtures: typeof local_fixtures;
  local_identity: typeof local_identity;
  local_smoke: typeof local_smoke;
  login_guard: typeof login_guard;
  media_job_actions: typeof media_job_actions;
  page_http: typeof page_http;
  page_image_actions: typeof page_image_actions;
  pages: typeof pages;
  pilot_access: typeof pilot_access;
  pilot_release: typeof pilot_release;
  pilot_retention: typeof pilot_retention;
  projects: typeof projects;
  retention: typeof retention;
  routing_schema: typeof routing_schema;
  seed: typeof seed;
  session_auth: typeof session_auth;
  staff_inbox: typeof staff_inbox;
  t3_config: typeof t3_config;
  t3_doctor: typeof t3_doctor;
  t3_identity: typeof t3_identity;
  t3_keys: typeof t3_keys;
  tag_rules: typeof tag_rules;
  ticket_requests: typeof ticket_requests;
  ticket_routing: typeof ticket_routing;
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

export declare const components: {
  auth: import("@convex-dev/auth/_generated/component.js").ComponentApi<"auth">;
  authPassword: import("@convex-dev/auth/components/password/_generated/component.js").ComponentApi<"authPassword">;
  authUsername: import("@convex-dev/auth/components/username/_generated/component.js").ComponentApi<"authUsername">;
  authClerk: import("@convex-dev/auth/components/oauth/_generated/component.js").ComponentApi<"authClerk">;
};
