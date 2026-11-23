import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalJobMutation } from "./functions";

/** Short-lived transport between the HTTP and Node runtimes. All readers are
 * internal and each read consumes its chunk. Expiry covers interrupted calls. */
export const put = internalJobMutation({
  name: "image_chunks:put",
  args: { bytes: v.bytes() },
  handler: async (ctx, { bytes }): Promise<Id<"imageChunks">> => {
    const id = await ctx.db.insert("imageChunks", { bytes });
    await ctx.scheduler.runAfter(15 * 60_000, internal.image_chunks.expire, {
      id,
    });
    return id;
  },
});

export const take = internalJobMutation({
  name: "image_chunks:take",
  args: { id: v.id("imageChunks") },
  handler: async (ctx, { id }): Promise<ArrayBuffer> => {
    const chunk = await ctx.db.get(id);
    if (!chunk) throw new Error("PAGE_PUBLISH_UNKNOWN");
    await ctx.db.delete(id);
    return chunk.bytes;
  },
});

export const expire = internalJobMutation({
  name: "image_chunks:expire",
  args: { id: v.id("imageChunks") },
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});
