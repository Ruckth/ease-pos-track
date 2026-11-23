import { v } from "convex/values";
import { actorMutation, actorQuery, internalActorMutation, internalJobMutation, internalJobQuery } from "./functions";
import * as pages from "./domain/pages";

export const listTicketPages = actorQuery({ name: "pages:listTicketPages", ...pages.listTicketPages });
export const revokeTicketPage = actorMutation({ name: "pages:revokeTicketPage", ...pages.revokeTicketPage });
/** The page host for clients that publish through the HTTP route. */
export const publishTarget = actorQuery({ name: "pages:publishTarget", args: {}, handler: () => ({ siteUrl: pages.siteUrl() }) });

export const authorize = internalActorMutation({ name: "pages:authorize", ...pages.authorizePublish });
export const reserve = internalActorMutation({ name: "pages:reserve", ...pages.reservePage });
export const commit = internalActorMutation({ name: "pages:commit", ...pages.commitPage });
export const recordStaged = internalJobMutation({
  name: "pages:recordStaged",
  args: { pageId: v.id("ticketPages"), marker: v.string(), path: v.string(), sha256: v.string(), size: v.number(), storageId: v.id("_storage") },
  handler: (ctx, args) => pages.recordStagedFile(ctx, args),
});
export const abandon = internalJobMutation({
  name: "pages:abandon", args: { pageId: v.id("ticketPages") },
  handler: (ctx, args) => pages.abandonPage(ctx, args.pageId),
});
export const resolve = internalJobQuery({
  name: "pages:resolve", args: { shareKey: v.string(), path: v.optional(v.string()) },
  handler: (ctx, args) => pages.resolveServedFile(ctx, args.shareKey, args.path),
});
export const expireStaging = internalJobMutation({ name: "pages:expireStaging", args: {}, handler: ctx => pages.expireStagingPages(ctx) });
export const reconcileWrites = internalJobMutation({ name: "pages:reconcileWrites", args: {}, handler: ctx => pages.reconcileDuePageWrites(ctx) });
export const reclaim = internalJobMutation({ name: "pages:reclaim", args: {}, handler: ctx => pages.reclaimPageStorage(ctx) });
