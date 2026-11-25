import { imageSize } from "image-size";
import { PDFDocument } from "pdf-lib";
import { lineAiLimits, type LineAiFile } from "./line_ai_provider";

const maxPdfPages = 12;
const maxImagePixels = 32_000_000;
const pngEnd = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];

function matches(bytes: Uint8Array, pattern: number[], offset = 0) {
  return offset >= 0 && pattern.every((byte, i) => bytes[offset + i] === byte);
}

function attachmentMime(bytes: Uint8Array): LineAiFile["mimeType"] {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (matches(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (matches(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  throw new Error("LINE_CONTENT_UNSUPPORTED");
}

/** Check bounded file metadata without rendering images or executing PDF content. */
export async function validateLineAttachment(bytes: Uint8Array, declaredMime?: string): Promise<LineAiFile> {
  if (!bytes.length || bytes.length > lineAiLimits.fileBytes) throw new Error("LINE_CONTENT_TOO_LARGE");
  const mimeType = attachmentMime(bytes);
  const declared = declaredMime?.split(";", 1)[0].trim().toLowerCase();
  if (declared && declared !== "application/octet-stream" && declared !== mimeType) {
    throw new Error("LINE_CONTENT_TYPE_MISMATCH");
  }
  if (mimeType === "application/pdf") {
    let pages: number;
    try {
      const tail = new TextDecoder().decode(bytes.subarray(-1024));
      if (!/%%EOF\s*$/.test(tail)) throw new Error();
      const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
      pages = document.getPageCount();
    } catch {
      throw new Error("LINE_CONTENT_MALFORMED");
    }
    if (pages < 1 || pages > maxPdfPages) throw new Error("LINE_CONTENT_PAGE_LIMIT");
  } else {
    const ending = mimeType === "image/png" ? pngEnd : [0xff, 0xd9];
    if (!matches(bytes, ending, bytes.length - ending.length)) throw new Error("LINE_CONTENT_MALFORMED");
    try {
      const { width, height, type } = imageSize(bytes);
      if (type !== (mimeType === "image/png" ? "png" : "jpg") || width < 1 || height < 1) throw new Error();
      if (width * height <= maxImagePixels) return { bytes, mimeType };
    } catch {
      throw new Error("LINE_CONTENT_MALFORMED");
    }
    throw new Error("LINE_CONTENT_PIXEL_LIMIT");
  }
  return { bytes, mimeType };
}
