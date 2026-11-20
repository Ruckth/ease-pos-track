import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { assertCustomerActor } from "./authz";
import { customerQuery, customerMutation } from "./functions";
import { customerInboxReader, inboxMembership, setStatusInboxPreference } from "./domain/inbox";

const projectArgs = { projectId: v.id("projects") };

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
