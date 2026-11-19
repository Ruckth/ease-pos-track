import { internal } from "./_generated/api";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { assertCustomerActor } from "./authz";
import { customerQuery, customerMutation, internalJobMutation } from "./functions";
import { approvedRetention } from "./pilot_access";
import { customerInboxReader, inboxMembership, setStatusInboxPreference } from "./domain/inbox";

const projectArgs = { projectId: v.id("projects") };
const DAY = 24 * 60 * 60 * 1000;
const BATCH = 256;

export const page = customerQuery({
  name: "inbox:page", args: { ...projectArgs, paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const member = await inboxMembership(ctx, args.projectId, assertCustomerActor(ctx.actor));
    if (!member) return { page: [], isDone: true, continueCursor: "" };
    const { numItems } = args.paginationOpts;
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 50) throw new Error("INVALID_INPUT");
    const visible = await customerInboxReader(ctx, member);
    const rows = await ctx.db.query("customerInbox").withIndex("by_member", q =>
      q.eq("memberId", member._id)).order("desc").paginate({ ...args.paginationOpts, maximumRowsRead: 50 });
    const items = await Promise.all(rows.page.map(async item => {
      const ticket = await visible(item);
      return ticket && { id: item._id, ticketId: ticket._id, number: ticket.ticketNumber, title: ticket.title,
        status: item.status, restored: item.restored, read: item.readAt !== undefined, date: item._creationTime };
    }));
    return { ...rows, page: items.filter(item => item !== null) };
  },
});

export const preference = customerQuery({
  name: "inbox:preference", args: projectArgs,
  handler: async (ctx, args) => {
    const member = await inboxMembership(ctx, args.projectId, assertCustomerActor(ctx.actor));
    return member ? member.statusInboxEnabled !== false : null;
  },
});

export const setPreference = customerMutation({
  name: "inbox:setPreference", args: { ...projectArgs, enabled: v.boolean() },
  handler: async (ctx, args) => {
    const member = await inboxMembership(ctx, args.projectId, assertCustomerActor(ctx.actor));
    if (!member) throw new Error("PROJECT_NOT_FOUND");
    await setStatusInboxPreference(ctx, member, args.enabled);
  },
});

export const markRead = customerMutation({
  name: "inbox:markRead", args: { id: v.id("customerInbox") },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.id);
    if (!item) return false;
    const member = await inboxMembership(ctx, item.projectId, assertCustomerActor(ctx.actor));
    if (!member || !await (await customerInboxReader(ctx, member))(item)) return false;
    if (item.readAt === undefined) await ctx.db.patch(item._id, { readAt: Date.now() });
    return true;
  },
});

/** Bounded, indexed deletion under the installed release's approved inbox period only. */
export const expire = internalJobMutation({
  name: "inbox:expire", args: {},
  handler: async (ctx): Promise<number> => {
    const retention = await approvedRetention(ctx);
    if (!retention) return 0;
    const cutoff = Date.now() - retention.inboxDays * DAY;
    const rows = await Promise.all([
      ctx.db.query("customerInbox").withIndex("by_creation_time", q => q.lt("_creationTime", cutoff)).take(BATCH),
      ctx.db.query("staffInbox").withIndex("by_creation_time", q => q.lt("_creationTime", cutoff)).take(BATCH),
    ]);
    const expired = rows.flat();
    await Promise.all(expired.map(row => ctx.db.delete(row._id)));
    if (rows.some(batch => batch.length === BATCH)) {
      await ctx.scheduler.runAfter(0, internal.inbox.expire, {});
    }
    return expired.length;
  },
});
