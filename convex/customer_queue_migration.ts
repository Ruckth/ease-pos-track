import { v } from "convex/values";
import { ticketCustomerQueueGroup } from "../shared/ticket-state";
import { internalJobMutation } from "./functions";

/** Backfill after the optional field is live. Repeat with the returned cursor until isDone. */
export const backfill = internalJobMutation({
  name: "customer_queue_migration:backfill",
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const { page, isDone, continueCursor } = await ctx.db.query("tickets")
      .paginate({ cursor: cursor ?? null, numItems: 25, maximumRowsRead: 25, maximumBytesRead: 1024 * 1024 });
    for (const ticket of page) {
      if (ticket.customerQueueGroup === undefined) {
        await ctx.db.patch(ticket._id, { customerQueueGroup: ticketCustomerQueueGroup(ticket.status) });
      }
    }
    return { isDone, continueCursor };
  },
});
