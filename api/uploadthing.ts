import { createRouteHandler } from "uploadthing/server";
import { uploadRouter } from "../server/uploadthing.js";
import { resolveUploadThingCallbackUrl } from "../server/uploadthing-callback.js";

const callbackUrl = resolveUploadThingCallbackUrl();
const handler = createRouteHandler({
  router: uploadRouter,
  ...(callbackUrl ? { config: { callbackUrl } } : {}),
});

export { handler as GET, handler as POST };
