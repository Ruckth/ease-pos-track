import { createRouteHandler } from "uploadthing/server";
import { legacyMode } from "../shared/pilot-settings.js";
import { api } from "../convex/_generated/api.js";
import { createServerRuntime } from "./runtime.js";
import { createUploadRouter } from "./uploadthing.js";
import { resolveUploadThingConfig } from "./uploadthing-callback.js";

export function legacyMediaTransport(
  env: Record<string, string | undefined>,
  checkBackend: () => Promise<boolean>,
  handle: (request: Request) => Response | Promise<Response>,
) {
  return async (request: Request) => {
    if (!legacyMode(env)) return new Response(null, { status: 404 });
    let allowed: boolean;
    try { allowed = await checkBackend(); }
    catch { return new Response(null, { status: 503 }); }
    if (!allowed) return new Response(null, { status: 404 });
    return handle(request);
  };
}

export function createMediaEndpoints(env = process.env, port?: number) {
  let runtime: ReturnType<typeof createServerRuntime> | undefined;
  let uploadHandler: ReturnType<typeof createRouteHandler> | undefined;
  const getRuntime = () => runtime ??= createServerRuntime(env);
  const checkBackend = () => getRuntime().convex.query(api.uploads.legacyTransportAvailable, {});
  return {
    upload: legacyMediaTransport(env, checkBackend, request => {
      uploadHandler ??= createRouteHandler({
        router: createUploadRouter(getRuntime().convex, env.UPLOAD_CALLBACK_SECRET),
        config: resolveUploadThingConfig(env, port),
      });
      return uploadHandler(request);
    }),
    cancelUpload: legacyMediaTransport(env, checkBackend, request => getRuntime().cancelUpload(request)),
  };
}
