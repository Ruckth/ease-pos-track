// Exposes the app's real browser image preparation to tests/browser/encoders.test.ts.
import { faithfulPixels, fitImage, pixelPolicy } from "../../shared/image-optimization";
import { assertPreparedRaster } from "../../shared/raster-structure";
import { optimizeBrowserImage } from "../../src/lib/optimize-image";
import { prepareRaster } from "../../src/lib/prepare-raster";

export type PreparedSummary = {
  type: string; name: string; size: number; width: number; height: number; frames: number;
  photo: boolean; strict: boolean; tolerant: boolean;
} | { error: string };

/** Prepare base64 bytes as a selected File would be, then judge the result
 * against the browser's own resized drawing of the original. */
async function prepare(base64: string, name: string, type: string): Promise<PreparedSummary> {
  const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type });
  let output: File;
  try {
    output = await optimizeBrowserImage(file);
  } catch (error) {
    return { error: (error as Error).message };
  }
  const prepared = assertPreparedRaster(new Uint8Array(await output.arrayBuffer()));
  const original = await createImageBitmap(file, { imageOrientation: "from-image" });
  const { width, height } = fitImage(original.width, original.height);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(original, 0, 0, width, height);
  const reference = ctx.getImageData(0, 0, width, height).data;
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(await createImageBitmap(output), 0, 0);
  const pixels = ctx.getImageData(0, 0, width, height).data;
  return {
    type: output.type, name: output.name, size: output.size, width: prepared.width, height: prepared.height, frames: prepared.frames,
    photo: pixelPolicy(reference, width).photo, strict: faithfulPixels(reference, pixels), tolerant: faithfulPixels(reference, pixels, true),
  };
}

/** The prepared bytes themselves, as base64, for inspection in Node. */
async function preparedBytes(base64: string, name: string, type: string) {
  const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type });
  const bytes = new Uint8Array(await (await optimizeBrowserImage(file)).arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** The same preparation on the main thread; files of 128 KiB or more otherwise use a worker. */
async function mainThread(base64: string, name: string, type: string) {
  const output = await prepareRaster(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type }));
  return { type: output.type, size: output.size };
}

Object.assign(window, { prepareForTest: prepare, preparedBytesForTest: preparedBytes, mainThreadForTest: mainThread });
