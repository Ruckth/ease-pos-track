import sharp from "sharp";
import {
  encodedName,
  faithfulPixels,
  IMAGE_SOURCE_BYTES,
  IMAGE_SOURCE_PIXELS,
  inspectRaster,
  jpegWithoutMetadata,
  rasterTraits,
  stripRasterMetadata,
} from "../image-optimization";

export async function optimizeImage(file: File): Promise<File> {
  try {
    if (file.size > IMAGE_SOURCE_BYTES) throw Error();
    const source = Buffer.from(await file.arrayBuffer());
    const info = inspectRaster(source);
    const traits = rasterTraits(source, info.type);
    if (traits.animated && info.width <= 1920 && info.height <= 1080) {
      const clean = stripRasterMetadata(new Uint8Array(source), info.type);
      return new File([clean], file.name, {
        type: info.type,
        lastModified: file.lastModified,
      });
    }
    if (info.type === "image/x-icon") {
      inspectRaster(source, true);
      return file;
    }
    const pipeline = sharp(source, {
      limitInputPixels: IMAGE_SOURCE_PIXELS,
      failOn: "warning",
    });
    const meta = await pipeline.metadata();
    if (traits.animated || (meta.pages ?? 1) > 1) {
      // Keep frame timing and disposal; animated PNG is not supported by libvips.
      if (info.type === "image/png" || info.type === "image/avif") {
        inspectRaster(source, true);
        return file;
      }
      if (info.width * info.height * (meta.pages ?? 1) > IMAGE_SOURCE_PIXELS)
        throw Error();
      const out = await sharp(source, {
        animated: true,
        limitInputPixels: IMAGE_SOURCE_PIXELS,
      })
        .resize({
          width: 1920,
          height: 1080,
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ lossless: true, effort: 3 })
        .toBuffer();
      return new File(
        [new Uint8Array(out)],
        encodedName(file.name, "image/webp"),
        { type: "image/webp" },
      );
    }
    const { data, info: raw } = await pipeline
      .rotate()
      .resize({
        width: 1920,
        height: 1080,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const base = sharp(data, {
      raw: { width: raw.width, height: raw.height, channels: 4 },
    });
    const hasAlpha = meta.hasAlpha;
    let best = await base
      .clone()
      .webp({ lossless: true, effort: 3 })
      .toBuffer();
    let type = "image/webp";
    if (
      traits.simple &&
      source.length <= best.length &&
      info.width === raw.width &&
      info.height === raw.height
    ) {
      best = source;
      type = info.type;
    }
    if (
      info.type === "image/jpeg" &&
      !traits.simple &&
      info.width === raw.width &&
      info.height === raw.height
    ) {
      const clean = jpegWithoutMetadata(source);
      if (clean && clean.length < best.length) {
        const pixels = await sharp(clean).ensureAlpha().raw().toBuffer();
        if (faithfulPixels(data, pixels)) {
          best = Buffer.from(clean);
          type = info.type;
        }
      }
    }
    if (best.length > 512) {
      const candidates = [
        {
          type: "image/webp",
          encode: () =>
            base.clone().webp({ quality: 90, smartSubsample: true }).toBuffer(),
        },
        ...(!hasAlpha
          ? [
              {
                type: "image/jpeg",
                encode: () =>
                  base
                    .clone()
                    .jpeg({ quality: 91, chromaSubsampling: "4:4:4" })
                    .toBuffer(),
              },
            ]
          : []),
        {
          type: "image/avif",
          encode: () =>
            base
              .clone()
              .avif({ quality: 70, effort: 3, chromaSubsampling: "4:4:4" })
              .toBuffer(),
        },
      ];
      for (const candidate of candidates) {
        const out = await candidate.encode();
        if (out.length >= best.length) continue;
        const pixels = await sharp(out).ensureAlpha().raw().toBuffer();
        if (faithfulPixels(data, pixels)) {
          best = out;
          type = candidate.type;
        }
      }
    }
    return new File([new Uint8Array(best)], encodedName(file.name, type), {
      type,
      lastModified: file.lastModified,
    });
  } catch {
    throw new Error("IMAGE_INVALID");
  }
}
