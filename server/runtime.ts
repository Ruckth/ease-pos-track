import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";
import { cancelUploadHandler } from "./handlers/cancel-upload.js";

export function createServerRuntime(env: NodeJS.ProcessEnv = process.env) {
  const url = env.CONVEX_URL ?? env.VITE_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL or VITE_CONVEX_URL is required by the upload server.");
  const convex = new ConvexHttpClient(url, { logger: false });
  return {
    convex,
    cancelUpload: cancelUploadHandler({
      cancel: input => convex.mutation(api.uploads.cancelUploadIntent, input),
    }),
  };
}
