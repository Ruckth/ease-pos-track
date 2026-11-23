import {
  encodedName,
  faithfulPixels,
  fitImage,
  IMAGE_SOURCE_BYTES,
  inspectRaster,
  jpegWithoutMetadata,
  rasterTraits,
  stripRasterMetadata,
} from "../../shared/image-optimization";

function encode(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number,
): Promise<Blob | null> {
  return "convertToBlob" in canvas
    ? canvas.convertToBlob({ type, quality })
    : new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

const encoders = new Map<string, boolean>();
async function supports(type: string) {
  if (encoders.has(type)) return encoders.get(type);
  const probe =
    typeof document === "undefined"
      ? new OffscreenCanvas(1, 1)
      : document.createElement("canvas");
  probe.width = probe.height = 1;
  let supported = false;
  try {
    supported = (await encode(probe, type))?.type === type;
  } catch {
    /* Optional encoder unavailable. */
  }
  encoders.set(type, supported);
  return supported;
}

async function decode(blob: Blob) {
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      if (typeof document === "undefined") throw new Error("IMAGE_INVALID");
    }
  }
  const url = URL.createObjectURL(blob);
  const img = new Image();
  try {
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareRaster(file: File) {
  if (file.size > IMAGE_SOURCE_BYTES) throw new Error("IMAGE_INVALID");
  const source = new Uint8Array(await file.arrayBuffer());
  const info = inspectRaster(source);
  const traits = rasterTraits(source, info.type);
  if (traits.animated || info.type === "image/x-icon") {
    inspectRaster(source, true);
    const clean = stripRasterMetadata(source, info.type);
    return clean === source && file.type === info.type
      ? file
      : new File([clean], file.name, {
          type: info.type,
          lastModified: file.lastModified,
        });
  }
  const image = await decode(file);
  const originalWidth = image.width,
    originalHeight = image.height;
  const { width, height } = fitImage(originalWidth, originalHeight);
  const canvas =
    typeof document === "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("IMAGE_INVALID");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  if ("close" in image) image.close();
  const reference = ctx.getImageData(0, 0, width, height);
  let best = await encode(canvas, "image/png");
  if (!best) throw new Error("IMAGE_INVALID");
  if (
    traits.simple &&
    width === originalWidth &&
    height === originalHeight &&
    file.size <= best.size &&
    file.type === info.type
  )
    best = file;
  if (
    info.type === "image/jpeg" &&
    !traits.simple &&
    width === info.width &&
    height === info.height
  ) {
    const clean = jpegWithoutMetadata(source);
    if (clean && clean.length < best.size) {
      const candidate = new Blob([clean], { type: info.type });
      const check = await decode(candidate);
      ctx.drawImage(check, 0, 0);
      if ("close" in check) check.close();
      if (
        faithfulPixels(
          reference.data,
          ctx.getImageData(0, 0, width, height).data,
        )
      )
        best = candidate;
    }
  }
  let opaque = true;
  for (let i = 3; i < reference.data.length; i += 4)
    if (reference.data[i] !== 255) {
      opaque = false;
      break;
    }
  if (best.size > 512) {
    for (const [type, quality] of [
      ["image/webp", 0.92],
      ["image/jpeg", 0.92],
      ["image/avif", 0.84],
    ] as const) {
      if (type === "image/jpeg" && !opaque) continue;
      if (!(await supports(type))) continue;
      ctx.putImageData(reference, 0, 0);
      const candidate = await encode(canvas, type, quality);
      if (!candidate || candidate.type !== type || candidate.size >= best.size)
        continue;
      const check = await decode(candidate);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(check, 0, 0);
      if ("close" in check) check.close();
      if (
        faithfulPixels(
          reference.data,
          ctx.getImageData(0, 0, width, height).data,
        )
      )
        best = candidate;
    }
  }
  return best === file
    ? file
    : new File([best], encodedName(file.name, best.type), {
        type: best.type,
        lastModified: file.lastModified,
      });
}
