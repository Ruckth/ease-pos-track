import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { actorFields } from "../authz";
import { hasLegacyAccess, requireLegacyMedia } from "../pilot_access";
import { mediaItemValidator, messageLinkValidator } from "../schema";
import { requireCurrentVersion } from "../../shared/ticket-state";
import { validateMediaItems } from "../../shared/media-policy";
import { pageUrl } from "../../shared/ticket-pages";
import { normalizeTicketReplyUrl } from "../../shared/ticket-reply-link";
import { normalizeRequestId } from "../ticket_requests";
import { attachIntentAssets, requireOwnedUploadIntent, verifyAssetReceipts, verifyPendingUploadIntent } from "./media";
import { readableTicket } from "./operations";
import { ticketExcerpt } from "./reads";
import { siteUrl } from "./pages";
import { requireUsableProject } from "./projects";
import { applyTicketChange } from "./tickets";
import { mutationOperation, queryOperation } from "./operation";

const MAX_BODY = 2000;
const QUOTE_EXCERPT = 200;

type Message = Doc<"ticketMessages">;
type StoredLink = NonNullable<Message["link"]>;
export type HydratedLink =
  | { kind: "external"; url: string }
  | { kind: "page"; pageId: Id<"ticketPages">; title: string; url?: string };

function normalizeLink(link: StoredLink | undefined): StoredLink | undefined {
  if (!link) return undefined;
  return link.kind === "external" ? { kind: "external", url: normalizeTicketReplyUrl(link.url) } : { kind: "page", pageId: link.pageId };
}

const linkKey = (link: StoredLink | undefined) => !link ? "" : link.kind === "external" ? `external:${link.url}` : `page:${link.pageId}`;

const sameKeys = (a: string[] | undefined, b: string[]) => (a ?? []).length === b.length && b.every((key, i) => a![i] === key);

/** Staff messages default to requesting a reply, as legacy clients expect. */
const effectiveRequestReply = (row: Pick<Message, "role" | "requestReply">) =>
  row.role === "staff" ? row.requestReply ?? true : undefined;

async function hydrateLink(ctx: QueryCtx, ticketId: Id<"tickets">, link: StoredLink | undefined, hostedPagesEnabled: boolean): Promise<HydratedLink | undefined> {
  if (!link) return undefined;
  if (link.kind === "external") return { kind: "external", url: link.url };
  if (!hostedPagesEnabled) return undefined;
  const page = await ctx.db.get(link.pageId);
  // Only this Ticket's own pages are hydrated; anything else reads as unavailable.
  if (!page || page.ticketId !== ticketId) return { kind: "page", pageId: link.pageId, title: "" };
  let url: string | undefined;
  if (page.state === "published" && page.shareKey) {
    try { url = pageUrl(siteUrl(), page.shareKey, page.entryPath); } catch { url = undefined; }
  }
  return { kind: "page", pageId: page._id, title: page.entryPath, ...(url ? { url } : {}) };
}

export const pageMessages = queryOperation({
  args: { id: v.id("tickets"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const ticket = await readableTicket(ctx, ctx.actor, args.id);
    const project = ticket && await ctx.db.get(ticket.projectId);
    if (!ticket?.ownerCustomerId || !project || project.archivedAt !== undefined) {
      return { page: [], isDone: true, continueCursor: "" };
    }
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 30) throw new Error("INVALID_INPUT");
    const result = await ctx.db.query("ticketMessages").withIndex("by_ticket", q => q.eq("ticketId", args.id))
      .order("desc").paginate({ ...args.paginationOpts, maximumRowsRead: 30, maximumBytesRead: 256_000 });
    const legacyAccess = await hasLegacyAccess(ctx);
    const mediaByKey = new Map(legacyAccess ? ticket.media.map(item => [item.key, item]) : []);
    const page = await Promise.all(result.page.map(async row => {
      const quoted = row.inReplyTo ? await ctx.db.get(row.inReplyTo) : null;
      const quote = quoted && quoted.ticketId === ticket._id ? {
        id: quoted._id, role: quoted.role, body: ticketExcerpt(quoted.body, QUOTE_EXCERPT),
        ...(quoted.link ? { link: await hydrateLink(ctx, ticket._id, quoted.link, legacyAccess) } : {}),
        ...(quoted.mediaKeys?.some(key => mediaByKey.has(key)) ? { hasMedia: true } : {}),
      } : undefined;
      const link = await hydrateLink(ctx, ticket._id, row.link, legacyAccess);
      const requestReply = effectiveRequestReply(row);
      return {
        _id: row._id, _creationTime: row._creationTime, role: row.role, body: row.body,
        ...(row.inReplyTo ? { inReplyTo: row.inReplyTo } : {}),
        ...(quote ? { quote } : {}),
        ...(link ? { link } : {}),
        media: (row.mediaKeys ?? []).flatMap(key => mediaByKey.get(key) ?? []),
        ...(requestReply === undefined ? {} : { requestReply }),
      };
    }));
    return { ...result, page };
  },
});

export const sendMessage = mutationOperation({
  args: {
    id: v.id("tickets"), body: v.string(), requestId: v.string(),
    expectedVersion: v.number(), inReplyTo: v.optional(v.id("ticketMessages")),
    requestReply: v.optional(v.boolean()),
    link: v.optional(messageLinkValidator),
    media: v.optional(v.array(mediaItemValidator)),
    uploadIntentId: v.optional(v.id("uploadIntents")),
    uploadIntentSecret: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { actor } = ctx;
    const ticket = await readableTicket(ctx, actor, args.id);
    if (!ticket?.ownerCustomerId || ticket.lifecycle !== "active") throw new Error("TICKET_UNAVAILABLE");
    await requireUsableProject(ctx, actor, ticket.projectId);

    // Validate shape and role before touching pages, intents or storage receipts.
    const body = args.body.trim();
    const media = args.media ?? [];
    const hasMedia = media.length > 0 || args.uploadIntentId !== undefined || args.uploadIntentSecret !== undefined;
    if (actor.role === "customer" && (args.requestReply === true || args.link?.kind === "page")) throw new Error("STAFF_ONLY");
    const requestReply = actor.role === "staff" ? args.requestReply ?? true : undefined;
    const link = normalizeLink(args.link);
    if (body.length > MAX_BODY || (!body && !link && !hasMedia)) throw new Error("INVALID_INPUT");
    if (hasMedia) {
      requireLegacyMedia();
      if (!media.length) throw new Error("UPLOAD_INCOMPLETE");
      if (args.uploadIntentId === undefined || args.uploadIntentSecret === undefined) throw new Error("UPLOAD_INTENT_INVALID");
    }
    const mediaKeys = media.map(item => item.key);
    const requestId = normalizeRequestId(args.requestId);

    const previous = await ctx.db.query("ticketMessages").withIndex("by_ticket_request", q =>
      q.eq("ticketId", args.id).eq("requestId", requestId)).unique();
    if (previous) {
      if (previous.role !== actor.role || previous.customerId !== actor.customerId || previous.staffId !== actor.staffId
        || previous.body !== body || previous.inReplyTo !== args.inReplyTo || effectiveRequestReply(previous) !== requestReply
        || linkKey(previous.link) !== linkKey(link) || !sameKeys(previous.mediaKeys, mediaKeys)
        || previous.uploadIntentId !== args.uploadIntentId) throw new Error("REQUEST_ID_CONFLICT");
      if (hasMedia) {
        requireOwnedUploadIntent(await ctx.db.get(args.uploadIntentId!), actor, args.uploadIntentSecret!);
        await verifyAssetReceipts(ctx, args.uploadIntentId!, media, ticket._id);
      }
      return previous._id;
    }

    if (ticket.status === "done") throw new Error("TICKET_RESOLVED");
    if (args.inReplyTo) {
      const target = await ctx.db.get(args.inReplyTo);
      if (!target || target.ticketId !== ticket._id) throw new Error("INVALID_INPUT");
    }
    if (link?.kind === "page") {
      if (!await hasLegacyAccess(ctx)) throw new Error("PAGE_UNAVAILABLE");
      const page = await ctx.db.get(link.pageId);
      if (!page || page.ticketId !== ticket._id || page.state !== "published") throw new Error("PAGE_UNAVAILABLE");
    }
    // Ticket state changes keep the optimistic version guard; plain thread posts do not.
    if (requestReply || hasMedia) requireCurrentVersion(ticket, args.expectedVersion);
    const intent = hasMedia ? requireOwnedUploadIntent(await ctx.db.get(args.uploadIntentId!), actor, args.uploadIntentSecret!) : null;
    if (intent) {
      validateMediaItems([...ticket.media, ...media]);
      await verifyPendingUploadIntent(ctx, intent, media);
    }

    const author = { sessionId: ctx.session._id, ...actorFields(actor) };
    let doc = ticket;
    if (requestReply && doc.status !== "waiting") {
      await applyTicketChange(ctx, {
        doc, expectedVersion: doc.version, changes: { status: "waiting" }, action: "status_changed", author, now: Date.now(),
      });
      doc = (await ctx.db.get(doc._id))!;
    }
    if (intent) {
      await applyTicketChange(ctx, {
        doc, expectedVersion: doc.version, changes: { media: [...doc.media, ...media] }, action: "media_attached", author, now: Date.now(),
      });
      await attachIntentAssets(ctx, intent, doc._id, media);
    }
    // Thread activity has its own timestamp and leaves the Ticket version alone.
    await ctx.db.patch(ticket._id, {
      ...(intent ? { replyMediaKeys: [...(ticket.replyMediaKeys ?? []), ...mediaKeys] } : {}),
      latestReply: {
        role: actor.role,
        at: Date.now(),
        excerpt: ticketExcerpt(body),
        ...(link ? { hasLink: true } : {}),
        awaitingCustomer: actor.role === "staff" && (requestReply === true || (ticket.status === "waiting" && ticket.latestReply?.awaitingCustomer === true)),
      },
    });
    return await ctx.db.insert("ticketMessages", {
      ticketId: args.id, role: actor.role, authorSessionId: ctx.session._id, customerId: actor.customerId, staffId: actor.staffId,
      body, requestId, inReplyTo: args.inReplyTo,
      ...(requestReply === undefined ? {} : { requestReply }),
      ...(link ? { link } : {}),
      ...(intent ? { mediaKeys, uploadIntentId: intent._id } : {}),
    });
  },
});
