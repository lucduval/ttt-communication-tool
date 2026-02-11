/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions_debug_dynamics from "../actions/debug_dynamics.js";
import type * as actions_dynamics from "../actions/dynamics.js";
import type * as actions_email from "../actions/email.js";
import type * as actions_graph_mailboxes from "../actions/graph_mailboxes.js";
import type * as actions_whatsapp from "../actions/whatsapp.js";
import type * as admin from "../admin.js";
import type * as campaignBatches from "../campaignBatches.js";
import type * as campaignQueue from "../campaignQueue.js";
import type * as campaigns from "../campaigns.js";
import type * as dashboard from "../dashboard.js";
import type * as files from "../files.js";
import type * as http from "../http.js";
import type * as lib_dynamics_auth from "../lib/dynamics_auth.js";
import type * as lib_dynamics_logging from "../lib/dynamics_logging.js";
import type * as lib_dynamics_util from "../lib/dynamics_util.js";
import type * as lib_graph_client from "../lib/graph_client.js";
import type * as lib_whatsapp from "../lib/whatsapp.js";
import type * as messages from "../messages.js";
import type * as notifications from "../notifications.js";
import type * as users from "../users.js";
import type * as whatsappTemplates from "../whatsappTemplates.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "actions/debug_dynamics": typeof actions_debug_dynamics;
  "actions/dynamics": typeof actions_dynamics;
  "actions/email": typeof actions_email;
  "actions/graph_mailboxes": typeof actions_graph_mailboxes;
  "actions/whatsapp": typeof actions_whatsapp;
  admin: typeof admin;
  campaignBatches: typeof campaignBatches;
  campaignQueue: typeof campaignQueue;
  campaigns: typeof campaigns;
  dashboard: typeof dashboard;
  files: typeof files;
  http: typeof http;
  "lib/dynamics_auth": typeof lib_dynamics_auth;
  "lib/dynamics_logging": typeof lib_dynamics_logging;
  "lib/dynamics_util": typeof lib_dynamics_util;
  "lib/graph_client": typeof lib_graph_client;
  "lib/whatsapp": typeof lib_whatsapp;
  messages: typeof messages;
  notifications: typeof notifications;
  users: typeof users;
  whatsappTemplates: typeof whatsappTemplates;
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
