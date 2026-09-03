import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { UTApi } from "uploadthing/server";
import { authError, inputError, remoteError } from "./errors";

export const MAX_TICKET_IMAGES = 10;
export const MAX_TICKET_IMAGE_BYTES = 8 * 1024 * 1024;

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

function assertImageSize(size: number) {
  if (size <= 0 || size > MAX_TICKET_IMAGE_BYTES) {
    throw inputError("IMAGE_SIZE_INVALID", "Each --image must be larger than zero and no more than 8 MB.");
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
    throw inputError("INVALID_IMAGE_SOURCE", `Image source is neither a local path nor a valid HTTPS URL: ${source}`);
  }
  if (url.protocol !== "https:") throw inputError("INVALID_IMAGE_SOURCE", "Remote --image sources must use HTTPS.");

  let response: Response;
  try {
    response = await fetcher(url, { redirect: "follow" });
  } catch {
    throw inputError("IMAGE_DOWNLOAD_FAILED", `Unable to download image: ${url.toString()}`);
  }
  if (!response.ok) throw inputError("IMAGE_DOWNLOAD_FAILED", `Image download returned HTTP ${response.status}.`);
  const finalUrl = new URL(response.url || url.toString());
  if (finalUrl.protocol !== "https:") throw inputError("INVALID_IMAGE_SOURCE", "Image redirects must remain on HTTPS.");
  const type = imageType(finalUrl.pathname, response.headers.get("content-type"));
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > 0) assertImageSize(declaredSize);
  const bytes = await response.arrayBuffer();
  assertImageSize(bytes.byteLength);
  const name = remoteName(finalUrl, type, index);
  return new File([bytes], name, { type });
}

/** Resolve local paths and HTTPS links into original, untransformed image files. */
export async function prepareTicketImages(sources: string[], fetcher: typeof fetch = fetch) {
  if (sources.length > MAX_TICKET_IMAGES) {
    throw inputError("IMAGE_LIMIT_EXCEEDED", `At most ${MAX_TICKET_IMAGES} --image values are allowed.`);
  }
  return await Promise.all(sources.map((rawSource, index) => {
    const source = rawSource.trim();
    if (!source) throw inputError("INVALID_IMAGE_SOURCE", "--image cannot be blank.");
    return source.includes("://") ? remoteImage(source, index, fetcher) : localImage(source);
  }));
}

/** Upload prepared originals with the server SDK; links and paths share one store. */
export class UploadThingTicketImages implements TicketImages {
  constructor(private readonly token: string | undefined = process.env.UPLOADTHING_TOKEN) {}

  prepare(sources: string[]) {
    return prepareTicketImages(sources);
  }

  async upload(files: File[]) {
    if (!this.token) {
      throw authError(
        "UPLOAD_NOT_CONFIGURED",
        "Image upload requires UPLOADTHING_TOKEN.",
        "Configure UPLOADTHING_TOKEN, then retry with the same --request-id.",
      );
    }
    const results = await new UTApi({ token: this.token }).uploadFiles(files, { concurrency: 4 });
    return results.map((result) => {
      if (!result.data) {
        throw remoteError(`Image upload failed: ${result.error?.message ?? "UploadThing returned no file."}`);
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
