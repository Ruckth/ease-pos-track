import { serve } from "@hono/node-server";
import { config } from "dotenv";
import { createUploadApp } from "./app";
import { createMediaEndpoints } from "./media-transport";
import { loadPorts } from "../scripts/worktree-ports.mjs";

config({ path: ".env.local", quiet: true });
const port = Number(process.env.UPLOAD_API_PORT ?? loadPorts().UPLOAD_API_PORT);
const endpoints = createMediaEndpoints(process.env, port);
const app = createUploadApp(endpoints, endpoints.upload);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Upload API listening on http://localhost:${port}`);
});
