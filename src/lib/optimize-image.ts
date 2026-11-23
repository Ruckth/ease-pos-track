import { optimizeEmbeddedImages } from "../../shared/html-images";
import { prepareRaster } from "./prepare-raster";
const prepared = new WeakMap<File, Promise<File>>();
let queue: Promise<void> = Promise.resolve();

async function prepare(file: File) {
  if (
    file.size < 128 * 1024 ||
    typeof Worker === "undefined" ||
    typeof OffscreenCanvas === "undefined" ||
    typeof createImageBitmap !== "function"
  ) {
    return prepareRaster(file);
  }
  let worker: Worker | undefined;
  try {
    worker = new Worker(new URL("./image-worker.ts", import.meta.url), {
      type: "module",
    });
    const active = worker;
    const result = await new Promise<File | null>((resolve, reject) => {
      active.onmessage = (e) => resolve(e.data);
      active.onerror = () => reject(new Error("Worker unavailable"));
      active.postMessage(file);
    });
    if (result) return result;
  } catch {
    /* Restricted worker environments can still encode on the main thread. */
  } finally {
    worker?.terminate();
  }
  return prepareRaster(file);
}

export function optimizeBrowserImage(file: File) {
  let cached = prepared.get(file);
  if (!cached) {
    cached = queue
      .then(() => prepare(file))
      .catch(() => {
        prepared.delete(file);
        throw new Error("IMAGE_INVALID");
      });
    queue = cached.then(
      () => undefined,
      () => undefined,
    );
    prepared.set(file, cached);
  }
  return cached;
}

const preparedPages = new WeakMap<File, Promise<File>>();
export async function preparePageAsset(file: File, type: string) {
  if (type.startsWith("image/")) return optimizeBrowserImage(file);
  if (!type.startsWith("text/html")) return file;
  if (file.size > 10 * 1024 * 1024) throw new Error("PAGE_TOO_LARGE");
  let result = preparedPages.get(file);
  if (!result) {
    result = optimizeEmbeddedImages(file, optimizeBrowserImage).catch(
      (error) => {
        preparedPages.delete(file);
        throw error;
      },
    );
    preparedPages.set(file, result);
  }
  return result;
}
