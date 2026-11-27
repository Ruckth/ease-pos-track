import { errorCode } from "../../../shared/errors";
import { PAGE_LIMITS, pageContentType, validatePageBundle } from "../../../shared/ticket-pages";

/**
 * `server`: originals are sent once and the deployment's Sharp pipeline converts
 * them (WebP, AVIF or a cleaned original, whichever is smallest and faithful).
 * `browser`: native canvas encoders prepare images first, for selections whose
 * originals exceed the request limits.
 */
export type ImagePolicy = "server" | "browser";
export type PageSelection = { entry: string; files: Array<{ path: string; blob: File }>; policy?: ImagePolicy };
type PageFile = { path: string; size: number; blob: Blob };

export async function publishPageSelection<R>(selection: PageSelection, deps: {
  prepare: (file: File, type: string) => Promise<Blob>;
  /** Called once the bytes are fixed: a retry must reuse this policy and request id. */
  onPolicy: (policy: ImagePolicy) => void;
  send: (entry: string, files: PageFile[], prepared: boolean) => Promise<R>;
}): Promise<R> {
  const originals = selection.files.map(file => ({ path: file.path, size: file.blob.size, blob: file.blob as Blob }));
  validatePageBundle(selection.entry, originals.map(file => ({ path: file.path, size: 0 })));
  let policy = selection.policy ?? (fits(selection.entry, originals) ? "server" : "browser");
  for (;;) {
    try {
      const bundle = validatePageBundle(selection.entry, policy === "server" ? originals : await prepared(selection.files, deps.prepare));
      deps.onPolicy(policy);
      return await deps.send(bundle.entry, bundle.files, policy === "browser");
    } catch (error) {
      // Server output over the limit is refused before anything is reserved, so
      // the first attempt may still switch to browser preparation.
      if (policy === "server" && !selection.policy && errorCode(error) === "PAGE_TOO_LARGE") { policy = "browser"; continue; }
      throw error;
    }
  }
}

function fits(entry: string, files: PageFile[]) {
  try { validatePageBundle(entry, files); return true; }
  catch (error) { if (errorCode(error) === "PAGE_TOO_LARGE") return false; throw error; }
}

async function prepared(files: PageSelection["files"], prepare: (file: File, type: string) => Promise<Blob>) {
  const output: PageFile[] = [];
  let totalBytes = 0;
  for (const file of files) {
    const blob = await prepare(file.blob, pageContentType(file.path));
    totalBytes += blob.size;
    if (totalBytes > PAGE_LIMITS.maxTotalBytes) throw new Error("PAGE_TOO_LARGE");
    output.push({ path: file.path, size: blob.size, blob });
  }
  return output;
}
