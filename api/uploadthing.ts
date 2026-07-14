import { createRouteHandler } from "uploadthing/server";
import { uploadRouter } from "../server/uploadthing.js";

const handler = createRouteHandler({
  router: uploadRouter,
});

export { handler as GET, handler as POST };
