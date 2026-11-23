"use node";

import { imageTransfer, packImage, unpackImage } from "./image_transfer";
import { ConvexError, v } from "convex/values";
import { internalJobAction } from "./functions";
import {
  pageContentType,
  isPageHtml,
  PAGE_LIMITS,
} from "../shared/ticket-pages";
import { optimizeImage } from "../shared/node/optimize-image";
import { validatePreparedRaster } from "../shared/node/validate-raster";
import { optimizeEmbeddedImages } from "../shared/html-images";
import { inspectRaster } from "../shared/image-optimization";
import { rasterTraits } from "../shared/raster-structure";

/** Embedded images a client prepared are validated, never re-encoded. */
async function acceptPrepared(file: File) {
  await validatePreparedRaster(new Uint8Array(await file.arrayBuffer()));
  return file;
}

/** Server-converted embedded images pass the same validation as client-prepared ones. */
async function convertEmbedded(file: File) {
  return acceptPrepared(await optimizeImage(file));
}

async function prepareBytes(
  path: string,
  sourceBytes: ArrayBuffer,
  prepared: boolean,
): Promise<{ bytes?: ArrayBuffer; rasterType?: string }> {
  const file = new File([sourceBytes], path, {
    type: pageContentType(path),
  });
  try {
    if (isPageHtml(path)) {
      const html = await optimizeEmbeddedImages(
        file,
        prepared ? acceptPrepared : convertEmbedded,
      );
      if (html.size > PAGE_LIMITS.maxTotalBytes)
        throw new Error("PAGE_TOO_LARGE");
      return html === file ? {} : { bytes: await html.arrayBuffer() };
    }
    const source = new Uint8Array(sourceBytes);
    const { type, width, height } = inspectRaster(source);
    const tiny =
      source.length <= 512 &&
      width <= 1920 &&
      height <= 1080 &&
      rasterTraits(source, type).clean;
    if (prepared || tiny)
      return { rasterType: await validatePreparedRaster(source) };
    const output = await optimizeImage(file);
    if (output.size > PAGE_LIMITS.maxTotalBytes)
      throw new Error("PAGE_TOO_LARGE");
    const bytes = await output.arrayBuffer();
    return {
      bytes,
      rasterType: await validatePreparedRaster(new Uint8Array(bytes)),
    };
  } catch (error) {
    if (error instanceof Error && error.message === "PAGE_TOO_LARGE")
      throw new ConvexError({ code: "PAGE_TOO_LARGE" });
    throw new ConvexError({ code: "PAGE_IMAGE_INVALID" });
  }
}

export const prepare = internalJobAction({
  name: "page_image_actions:prepare",
  args: { path: v.string(), bytes: imageTransfer, prepared: v.boolean() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    bytes?: Awaited<ReturnType<typeof packImage>>;
    rasterType?: string;
  }> => {
    const sourceBytes = await unpackImage(ctx, args.bytes);
    const output = await prepareBytes(args.path, sourceBytes, args.prepared);
    return {
      rasterType: output.rasterType,
      bytes: output.bytes ? await packImage(ctx, output.bytes) : undefined,
    };
  },
});
