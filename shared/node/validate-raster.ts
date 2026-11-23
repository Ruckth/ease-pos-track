import sharp from "sharp";
import {
  IMAGE_SOURCE_PIXELS,
  inspectRaster,
  rasterTraits,
  stripRasterMetadata,
} from "../image-optimization.js";

/** Validate untrusted bytes independently of the encoder. Decoding also catches
 * corrupt pixel data whose file signature and declared dimensions look valid. */
export async function validatePreparedRaster(bytes: Uint8Array<ArrayBuffer>) {
  const { type } = inspectRaster(bytes, true);
  rasterTraits(bytes, type);
  if (stripRasterMetadata(bytes, type) !== bytes)
    throw new Error("IMAGE_INVALID");
  if (type === "image/x-icon") return type;
  const pipeline = sharp(Buffer.from(bytes), {
    limitInputPixels: IMAGE_SOURCE_PIXELS,
    failOn: "warning",
    animated: true,
  });
  const meta = await pipeline.metadata();
  if (
    meta.exif ||
    meta.xmp ||
    meta.iptc ||
    meta.comments?.length ||
    (meta.width ?? 0) > 1920 ||
    (meta.pageHeight ?? meta.height ?? 0) > 1080 ||
    (meta.width ?? 0) * (meta.height ?? 0) > IMAGE_SOURCE_PIXELS
  )
    throw new Error("IMAGE_INVALID");
  await pipeline
    .resize({ width: 1, height: 1, fit: "inside" })
    .raw()
    .toBuffer();
  return type;
}
