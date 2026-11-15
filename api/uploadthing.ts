import { createServerRuntime } from "../server/runtime.js";
import { createRouteHandler } from "uploadthing/server";
import { createUploadRouter } from "../server/uploadthing.js";
import { resolveUploadThingConfig } from "../server/uploadthing-callback.js";

const handler = createRouteHandler({
  router: createUploadRouter(createServerRuntime().convex, process.env.UPLOAD_CALLBACK_SECRET),
  config: resolveUploadThingConfig(),
});

export { handler as GET, handler as POST };
