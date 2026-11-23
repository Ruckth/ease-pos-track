import { optimizeImage } from "../../shared/node/optimize-image";
import { IMAGE_SOURCE_BYTES } from "../../shared/image-optimization";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { UTApi } from "uploadthing/server";
import { authError, inputError, remoteError } from "./errors";

const MAX_TICKET_IMAGES = 10;
const MAX_TICKET_IMAGE_BYTES = 8 * 1024 * 1024;

export type TicketMediaItem = {
  key: string;
  name: string;
  size: number;
  type: string;
  url: string;
};

export interface TicketImages {
  prepare(sources: string[]): Promise<File[]>;
  upload(files: File[]): Promise<TicketMediaItem[]>;
}

type UploadProvider = { uploadFiles(files: File[]): Promise<Array<{ data: {
  key: string; name: string; size: number; type: string; ufsUrl: string;
} | null }>> };

const IMAGE_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function assertImageSize(size: number, limit = IMAGE_SOURCE_BYTES) {
  if (size <= 0 || size > limit) {
    throw inputError("IMAGE_SIZE_INVALID", "Each --image must be larger than zero and within the configured file size limit.");
  }
}

function imageType(name: string, supplied?: string | null) {
  const type = supplied?.split(";", 1)[0]?.trim().toLowerCase();
  if (type?.startsWith("image/")) return type;
  const inferred = IMAGE_TYPES[extname(name).toLowerCase()];
  if (inferred) return inferred;
  throw inputError("IMAGE_TYPE_UNSUPPORTED", `Unsupported image type for "${name}".`);
}

function remoteName(url: URL, type: string, index: number) {
  const pathName = decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) ?? "").trim();
  if (pathName) return pathName;
  const extension = Object.entries(IMAGE_TYPES).find(([, candidate]) => candidate === type)?.[0] ?? ".img";
  return `image-${index + 1}${extension}`;
}

async function localImage(source: string) {
  let metadata;
  try {
    metadata = await stat(source);
  } catch {
    throw inputError("IMAGE_FILE_NOT_FOUND", `Image file was not found: ${source}`);
  }
  if (!metadata.isFile()) throw inputError("INVALID_IMAGE_SOURCE", `Image path is not a file: ${source}`);
  assertImageSize(metadata.size);
  const name = basename(source);
  const type = imageType(name);
  return new File([await readFile(source)], name, { type, lastModified: metadata.mtimeMs });
}

async function remoteImage(source: string, index: number, fetcher: typeof fetch) {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw inputError("INVALID_IMAGE_SOURCE", "Image source must be a local path or a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") throw inputError("INVALID_IMAGE_SOURCE", "Remote --image sources must use HTTPS.");

  let response: Response;
  try {
    response = await fetcher(url, { redirect: "follow" });
  } catch {
    throw inputError("IMAGE_DOWNLOAD_FAILED", "Unable to download the image.");
  }
  if (!response.ok) throw inputError("IMAGE_DOWNLOAD_FAILED", `Image download returned HTTP ${response.status}.`);
  const finalUrl = new URL(response.url || url.toString());
  if (finalUrl.protocol !== "https:") throw inputError("INVALID_IMAGE_SOURCE", "Image redirects must remain on HTTPS.");
  const type = imageType(finalUrl.pathname, response.headers.get("content-type"));
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 0) assertImageSize(declaredSize);
  if (!response.body) throw inputError("IMAGE_SIZE_INVALID", "Empty image response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > IMAGE_SOURCE_BYTES) { await reader.cancel(); assertImageSize(size); }
    chunks.push(new Uint8Array(value));
  }
  assertImageSize(size);
  const name = remoteName(finalUrl, type, index);
  return new File(chunks, name, { type });
}

/** Resolve local paths and HTTPS links into bounded, optimized image files. */
export async function prepareTicketImages(sources: string[], fetcher: typeof fetch = fetch) {
  if (sources.length > MAX_TICKET_IMAGES) {
    throw inputError("IMAGE_LIMIT_EXCEEDED", `At most ${MAX_TICKET_IMAGES} --image values are allowed.`);
  }
  const images: File[] = [];
  for (const [index, rawSource] of sources.entries()) {
    const source = rawSource.trim();
    if (!source) throw inputError("INVALID_IMAGE_SOURCE", "--image cannot be blank.");
    const original = await (source.includes("://") ? remoteImage(source, index, fetcher) : localImage(source));
    const image = await optimizeImage(original).catch(() => { throw inputError("IMAGE_INVALID","Image decoding failed or the source exceeds the supported dimensions."); });
    assertImageSize(image.size, MAX_TICKET_IMAGE_BYTES);
    images.push(image);
  }
  return images;
}

/** Upload prepared images with the server SDK; links and paths share one store. */
export class UploadThingTicketImages implements TicketImages {
  private readonly provider?: UploadProvider;
  constructor(token: string | undefined, providerFactory: (token: string) => UploadProvider = token => new UTApi({ token })) {
    if (token) {
      try { this.provider = providerFactory(token); }
      catch { /* upload() returns the typed failure inside the CLI JSON boundary. */ }
    }
  }

  prepare(sources: string[]) {
    return prepareTicketImages(sources);
  }

  async upload(files: File[]) {
    if (!this.provider) {
      throw authError(
        "UPLOAD_NOT_CONFIGURED",
        "Image upload requires UPLOADTHING_TOKEN.",
        "Configure UPLOADTHING_TOKEN, then retry with the same --request-id.",
      );
    }
    let results;
    try { results = await this.provider.uploadFiles(files); }
    catch { throw remoteError("Image upload outcome is unknown. Retry with the same --request-id."); }
    return results.map((result) => {
      if (!result.data) {
        throw remoteError("Image upload failed. Retry with the same --request-id.");
      }
      return {
        key: result.data.key,
        name: result.data.name,
        size: result.data.size,
        type: result.data.type,
        url: result.data.ufsUrl,
      };
    });
  }
}
