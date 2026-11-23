import { optimizeEmbeddedImages } from "../../shared/html-images";
import { optimizeImage } from "../../shared/node/optimize-image";
import { IMAGE_SOURCE_BYTES } from "../../shared/image-optimization";
/**
 * Reads one page bundle from disk: a single HTML file, or a folder whose paths
 * stay relative to it. Hidden files are skipped and symbolic links are refused,
 * so nothing outside the chosen folder can be published.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PAGE_LIMITS, pageContentType, defaultPageEntry, isHiddenPagePath, validatePageBundle } from "../../shared/ticket-pages";
import { inputError, mapInputError } from "./errors";

export type PageBundle = { entry: string; files: Array<{ path: string; size: number; bytes: Uint8Array }>; totalBytes: number };

async function walk(root: string, relative: string, out: string[]) {
  for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${item.name}` : item.name;
    if (isHiddenPagePath(path)) continue;
    if (item.isSymbolicLink()) throw inputError("PAGE_PATH_INVALID", `"${path}" is a symbolic link; publish real files only.`);
    if (item.isDirectory()) await walk(root, path, out);
    else if (item.isFile()) out.push(path);
    // A count beyond the limit fails validation without reading any more bytes.
    if (out.length > PAGE_LIMITS.maxFiles) return;
  }
}

export async function readPageBundle(source: string, entry?: string): Promise<PageBundle> {
  const stat = await lstat(source).catch(() => null);
  if (!stat || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw inputError("PAGE_SOURCE_NOT_FOUND", `"${source}" is not an HTML file or folder.`);
  }
  const root = stat.isFile() ? join(source, "..") : source;
  const paths: string[] = [];
  if (stat.isFile()) paths.push(basename(source));
  else await walk(source, "", paths);
  const chosen = entry ?? defaultPageEntry(paths);
  if (chosen === undefined) {
    throw inputError("PAGE_ENTRY_REQUIRED", "The folder has several HTML files; pass --entry with the starting page's relative path.");
  }
  const entries = paths.map(path => ({ path, size: 0 }));
  try { validatePageBundle(chosen, entries); } catch (error) { throw mapInputError(error); }
  const files: PageBundle["files"] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const absolute = join(root, path);
    const type = pageContentType(path);
    const raster = type.startsWith("image/");
    const html = type.startsWith("text/html");
    const limit = raster ? IMAGE_SOURCE_BYTES : PAGE_LIMITS.maxTotalBytes;
    if ((await lstat(absolute)).size > limit) throw mapInputError(new Error("PAGE_TOO_LARGE"));
    let bytes = new Uint8Array(await readFile(absolute));
    if (raster || html) {
      const input = new File([bytes], basename(path), { type });
      const image = await (raster ? optimizeImage(input) : optimizeEmbeddedImages(input, optimizeImage));
      bytes = new Uint8Array(await image.arrayBuffer());
    }
    totalBytes += bytes.length;
    if (totalBytes > PAGE_LIMITS.maxTotalBytes) throw mapInputError(new Error("PAGE_TOO_LARGE"));
    files.push({ path, bytes, size: bytes.length });
  }
  return { entry: chosen, files, totalBytes };
}
