import { createUploadApp } from "./app";
import { serve } from "@hono/node-server";
import { createRouteHandler } from "uploadthing/server";
import { createUploadRouter } from "./uploadthing";
import { config } from "dotenv";
import { createServerRuntime } from "./runtime";

config({ path: ".env.local", quiet: true });
const runtime = createServerRuntime();
const uploadHandler = createRouteHandler({ router: createUploadRouter(runtime.convex, process.env.UPLOAD_CALLBACK_SECRET) });

const app = createUploadApp(runtime, uploadHandler);

const port = Number(process.env.UPLOAD_API_PORT ?? 8787);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Upload API listening on http://localhost:${port}`);
});
