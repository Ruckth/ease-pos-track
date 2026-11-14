import { v } from "convex/values";
import { internalJobMutation } from "../../../convex/functions";
import { applyTicketChange } from "../../../convex/domain/tickets";
import { tombstoneTicketRequests } from "../../../convex/domain/requests";

// Test-only finalization: no deployed purge endpoint or external storage I/O.
export const purge = internalJobMutation({
  args: { id: v.id("tickets"), sessionId: v.id("sessions") },
  handler: async (ctx, args) => {
    const doc = (await ctx.db.get(args.id))!;
    await applyTicketChange(ctx, {
      doc, expectedVersion: doc.version, changes: { lifecycle: "purging" }, action: "purge_claimed",
      author: { sessionId: args.sessionId, actorRole: "staff" }, now: Date.now(),
    });
    await tombstoneTicketRequests(ctx, args.id);
    await tombstoneTicketRequests(ctx, args.id); // Finalization retries are harmless.
    await ctx.db.delete(args.id); // Finalization does not touch totals again.
  },
});
