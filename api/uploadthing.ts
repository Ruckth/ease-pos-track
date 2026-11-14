import { createServerRuntime } from "../server/runtime.js";
import { createRouteHandler } from "uploadthing/server";
import { createUploadRouter } from "../server/uploadthing.js";
import { resolveUploadThingCallbackUrl } from "../server/uploadthing-callback.js";

const callbackUrl = resolveUploadThingCallbackUrl();
const handler = createRouteHandler({
  router: createUploadRouter(createServerRuntime().convex, process.env.UPLOAD_CALLBACK_SECRET),
  ...(callbackUrl ? { config: { callbackUrl } } : {}),
});

export { handler as GET, handler as POST };
