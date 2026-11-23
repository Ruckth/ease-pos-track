import { validatePreparedRaster } from "../shared/node/validate-raster.js";

/** Only the authenticated UploadThing callback supplies this URL and key. Transport
 * failures remain retryable; a definitive byte or format mismatch rejects the receipt. */
export async function validStoredImage(
  file: { key: string; size: number; type: string; ufsUrl: string },
  fetcher = fetch,
) {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    file.size > 8 * 1024 * 1024
  )
    return false;
  const url = new URL(file.ufsUrl);
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".ufs.sh") ||
    url.pathname !== "/f/" + file.key
  ) {
    throw new Error("UPLOAD_VERIFICATION_FAILED");
  }
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok || !response.body)
    throw new Error("UPLOAD_VERIFICATION_FAILED");
  const reader = response.body.getReader();
  const bytes = Buffer.alloc(file.size);
  let offset = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.length > bytes.length) {
      await reader.cancel();
      return false;
    }
    bytes.set(value, offset);
    offset += value.length;
  }
  if (offset !== bytes.length) return false;
  try {
    return (await validatePreparedRaster(new Uint8Array(bytes))) === file.type;
  } catch {
    return false;
  }
}
