// Exposes the app's real browser image preparation to tests/browser/encoders.test.ts.
import { faithfulPixels, fitImage, pixelPolicy } from "../../shared/image-optimization";
import { assertPreparedRaster } from "../../shared/raster-structure";
import { optimizeBrowserImage } from "../../src/lib/optimize-image";
import { exportMarkupImage, imageMarkupErrorCode, loadMarkupImage, type MarkupMark } from "../../src/lib/image-markup";
import { prepareRaster } from "../../src/lib/prepare-raster";
import { MEDIA_POLICY } from "../../shared/ticket-contracts";

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

export type MarkupInput = {
  base64: string;
  name: string;
  type: string;
  marks: MarkupMark[];
  encoder?: "null" | "jpeg-null" | "jpeg-png" | "jpeg-oversized-first" | "jpeg-oversized-all" | "png-oversized";
  pngPaddingChecksum?: number;
};

async function markupForTest({ base64, name, type, marks, encoder, pngPaddingChecksum }: MarkupInput) {
  const file = new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], name, { type });
  const image = await loadMarkupImage(file);
  const realEncode = HTMLCanvasElement.prototype.toBlob;
  const attempts: { type?: string; quality?: number }[] = [];
  if (encoder) {
    HTMLCanvasElement.prototype.toBlob = function (callback, requested, quality) {
      attempts.push({ type: requested, quality });
      if (encoder === "null" || (encoder === "jpeg-null" && requested === "image/jpeg")) {
        callback(null);
        return;
      }
      if (encoder === "jpeg-png" && requested === "image/jpeg") {
        realEncode.call(this, callback, "image/png");
        return;
      }
      if (encoder === "png-oversized" && requested === "image/png") {
        realEncode.call(this, async blob => {
          if (!blob) return callback(null);
          const bytes = new DataView(await blob.arrayBuffer());
          let lastImageData = 8;
          for (let start = 8; start < bytes.byteLength;) {
            const end = start + bytes.getUint32(start) + 12;
            if (bytes.getUint32(start + 4) === 0x49444154) lastImageData = end;
            start = end;
          }
          const header = new DataView(new ArrayBuffer(8));
          const crc = new DataView(new ArrayBuffer(4));
          header.setUint32(0, MEDIA_POLICY.image.maxBytes);
          header.setUint32(4, 0x49444154); // IDAT
          crc.setUint32(0, pngPaddingChecksum!);
          callback(new Blob([blob.slice(0, lastImageData), header, new Uint8Array(MEDIA_POLICY.image.maxBytes),
            crc, blob.slice(lastImageData)], { type: "image/png" }));
        }, requested, quality);
        return;
      }
      if (requested === "image/jpeg" && (encoder === "jpeg-oversized-all" ||
        (encoder === "jpeg-oversized-first" && attempts.length === 1))) {
        realEncode.call(this, async blob => {
          if (!blob) return callback(null);
          // Insert scan bytes ahead of the EOI marker to exercise the encoded size limit.
          const end = blob.size - 2;
          callback(new Blob([blob.slice(0, end), new Uint8Array(MEDIA_POLICY.image.maxBytes), blob.slice(end)], {
            type: "image/jpeg",
          }));
        }, requested, quality);
        return;
      }
      realEncode.call(this, callback, requested, quality);
    };
  }
  try {
    const output = await exportMarkupImage(image, marks, file.type);
    const bytes = new Uint8Array(await output.arrayBuffer());
    const prepared = assertPreparedRaster(bytes);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return { sourceWidth: image.width, sourceHeight: image.height, prepared, name: output.name,
      type: output.type, encoded: btoa(binary), attempts };
  } catch (error) {
    if (!encoder) throw error;
    return { error: imageMarkupErrorCode(error), attempts };
  } finally {
    HTMLCanvasElement.prototype.toBlob = realEncode;
    image.close();
  }
}

export type MarkupResult = Awaited<ReturnType<typeof markupForTest>>;

Object.assign(window, { markupForTest, prepareForTest: prepare, preparedBytesForTest: preparedBytes, mainThreadForTest: mainThread });
