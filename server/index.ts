import { createUploadApp } from "./app";
import { serve } from "@hono/node-server";
import { createRouteHandler } from "uploadthing/server";
import { createUploadRouter } from "./uploadthing";
import { config } from "dotenv";
import { createServerRuntime } from "./runtime";
import { loadPorts } from "../scripts/worktree-ports.mjs";
import { resolveUploadThingConfig } from "./uploadthing-callback";

config({ path: ".env.local", quiet: true });
const runtime = createServerRuntime();
const port = Number(process.env.UPLOAD_API_PORT ?? loadPorts().UPLOAD_API_PORT);
const uploadHandler = createRouteHandler({
  router: createUploadRouter(runtime.convex, process.env.UPLOAD_CALLBACK_SECRET),
  config: resolveUploadThingConfig(process.env, port),
});

const app = createUploadApp(runtime, uploadHandler);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Upload API listening on http://localhost:${port}`);
});
