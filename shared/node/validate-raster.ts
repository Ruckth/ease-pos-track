import sharp from "sharp";
import { IMAGE_ERRORS, IMAGE_HEIGHT, IMAGE_SOURCE_PIXELS, IMAGE_WIDTH } from "../image-optimization.js";
import { assertPreparedRaster } from "../raster-structure.js";

/**
 * Validate prepared bytes independently of whoever encoded them. The container
 * must be clean (see `assertPreparedRaster`), and Sharp must decode every frame
 * without warnings and report no metadata. ICO variants are checked one by one:
 * PNG variants decode here and bitmap variants must have their exact size.
 * Returns the detected MIME type; throws `IMAGE_INVALID`.
 */
export async function validatePreparedRaster(bytes: Uint8Array<ArrayBuffer>) {
  try {
    const prepared = assertPreparedRaster(bytes);
    if (prepared.type === "image/x-icon") {
      await decodeIconVariants(bytes);
      return prepared.type;
    }
    const pipeline = sharp(Buffer.from(bytes), { limitInputPixels: IMAGE_SOURCE_PIXELS, failOn: "warning", animated: true });
    const meta = await pipeline.metadata();
    // libvips draws only the first frame of an APNG; its frames were checked structurally.
    const frames = prepared.type === "image/png" ? 1 : prepared.frames;
    if (
      meta.exif || meta.xmp || meta.iptc || meta.icc || meta.comments?.length ||
      (meta.pages ?? 1) !== frames ||
      (meta.width ?? 0) > IMAGE_WIDTH ||
      (meta.pageHeight ?? meta.height ?? 0) > IMAGE_HEIGHT ||
      (meta.width ?? 0) * (meta.height ?? 0) > IMAGE_SOURCE_PIXELS
    )
      throw new Error(IMAGE_ERRORS.invalid);
    await pipeline.resize({ width: 1, height: 1, fit: "inside" }).raw().toBuffer();
    return prepared.type;
  } catch {
    throw new Error(IMAGE_ERRORS.invalid);
  }
}

async function decodeIconVariants(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < view.getUint16(4, true); index++) {
    const size = view.getUint32(6 + 16 * index + 8, true);
    const start = view.getUint32(6 + 16 * index + 12, true);
    const variant = bytes.subarray(start, start + size);
    if (variant[0] === 0x89) await sharp(Buffer.from(variant), { failOn: "warning" }).raw().toBuffer();
  }
}
