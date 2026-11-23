/**
 * Reads one page bundle from disk: a single HTML file, or a folder whose paths
 * stay relative to it. Hidden files are skipped and symbolic links are refused,
 * so nothing outside the chosen folder can be published.
 */
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PAGE_LIMITS, defaultPageEntry, isHiddenPagePath, validatePageBundle } from "../../shared/ticket-pages";
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
  const sizes = await Promise.all(paths.map(async path => ({ path, size: (await lstat(join(root, path))).size })));
  let bundle;
  try { bundle = validatePageBundle(chosen, sizes); }
  catch (error) { throw mapInputError(error); }
  const files = await Promise.all(bundle.files.map(async (file, index) => {
    const bytes = new Uint8Array(await readFile(join(root, sizes[index].path)));
    return { path: file.path, size: bytes.byteLength, bytes };
  }));
  return { entry: bundle.entry, files, totalBytes: files.reduce((sum, file) => sum + file.size, 0) };
}
