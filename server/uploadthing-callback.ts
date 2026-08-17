type CallbackEnvironment = Record<string, string | undefined>;

function validatedCallbackUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("UPLOADTHING_CALLBACK_URL must use http or https.");
  }
  return url;
}

/**
 * UploadThing normally derives the callback from the incoming request. Protected
 * Vercel previews need the automation bypass on the server-to-server callback,
 * while public production deployments should keep automatic origin detection.
 */
export function resolveUploadThingCallbackUrl(env: CallbackEnvironment = process.env) {
  const explicit = env.UPLOADTHING_CALLBACK_URL?.trim();
  if (explicit) return validatedCallbackUrl(explicit).toString();

  const vercelHost = env.VERCEL_URL?.trim();
  const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (!vercelHost || !bypassSecret) return undefined;

  const callback = validatedCallbackUrl(`https://${vercelHost}/api/uploadthing`);
  callback.searchParams.set("x-vercel-protection-bypass", bypassSecret);
  return callback.toString();
}
