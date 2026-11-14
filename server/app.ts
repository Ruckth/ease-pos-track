import { Hono } from "hono";
import { cors } from "hono/cors";

export function createUploadApp(
  runtime: { cancelUpload(request: Request): Promise<Response> },
  uploadHandler: (request: Request) => Promise<Response>,
) {
  const app = new Hono();
  app.use("/api/*", cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"],
    allowHeaders: ["authorization", "content-type", "x-uploadthing-package", "x-uploadthing-version"],
    allowMethods: ["GET", "POST", "OPTIONS"],
  }));
  app.get("/health", c => c.json({ ok: true }));
  app.all("/api/uploadthing", c => uploadHandler(c.req.raw));
  app.post("/api/uploads/cancel", c => runtime.cancelUpload(c.req.raw));
  return app;
}
