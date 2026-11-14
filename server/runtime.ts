import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import type { Id } from "../convex/_generated/dataModel.js";
import { cancelUploadHandler } from "./handlers/cancel-upload.js";
import { createStorage } from "./storage.js";

export function createServerRuntime(env: NodeJS.ProcessEnv = process.env) {
  const url = env.CONVEX_URL ?? env.VITE_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL or VITE_CONVEX_URL is required by the upload server.");
  const convex = new ConvexHttpClient(url);
  let storage: ReturnType<typeof createStorage> | undefined;
  return {
    convex,
    cancelUpload: cancelUploadHandler({
      cancel: ({ intentId, ...input }) => convex.mutation(api.uploads.cancelUploadIntent, {
        ...input, intentId: intentId as Id<"uploadIntents">,
      }),
      storage: () => storage ??= createStorage(env.UPLOADTHING_TOKEN),
    }),
  };
}
