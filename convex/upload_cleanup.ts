"use node";

import { UTApi } from "uploadthing/server";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";

export const cleanupExpiredUploads = internalAction({
  args: {},
  handler: async (ctx) => {
    const token = process.env.UPLOADTHING_TOKEN;
    if (!token) return { cleaned: 0, skipped: "UPLOADTHING_TOKEN is not configured in Convex." };

    const intents = await ctx.runQuery(internal.uploads.listExpiredIntents, {});
    const utapi = new UTApi({ token });
    let cleaned = 0;

    for (const intent of intents) {
      const keys = intent.uploadedFiles.map((file) => file.key);
      if (keys.length > 0) await utapi.deleteFiles(keys);
      await ctx.runMutation(internal.uploads.markIntentCleaned, { intentId: intent._id });
      cleaned += 1;
    }

    const archivedFeedback = await ctx.runQuery(internal.feedback.listFeedbackForPurge, {});
    for (const feedback of archivedFeedback) {
      const keys = feedback.media.map((file) => file.key);
      if (keys.length > 0) await utapi.deleteFiles(keys);
      await ctx.runMutation(internal.feedback.purgeFeedback, { id: feedback._id });
      cleaned += 1;
    }

    return { cleaned };
  },
});
