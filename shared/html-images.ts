import { inspectRaster } from "./image-optimization";

/**
 * Images converted together within one HTML document. A batch stays within a
 * decoded-pixel budget (4 bytes each), so one very large image runs alone.
 */
const BATCH_IMAGES = 4;
const BATCH_PIXELS = 12_000_000;

async function dataUrl(file: File) {
  const encoded = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < encoded.length; i += 8192)
    binary += String.fromCharCode(...encoded.subarray(i, i + 8192));
  return "data:" + file.type + ";base64," + btoa(binary);
}

/** Replace only literal img src attributes, using parser source offsets. Scripts,
 * CSS, ordinary URLs, markup whitespace and non-UTF-8 documents stay intact. */
export async function optimizeEmbeddedImages(
  html: File,
  optimize: (image: File) => Promise<File>,
) {
  const buffer = await html.arrayBuffer();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer,
    );
  } catch {
    return html;
  }
  if (!/data:image\/(?:png|jpeg|webp|avif);base64,/i.test(source)) return html;
  const { parse } = await import("parse5");
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const nodes: import("parse5").DefaultTreeAdapterTypes.Node[] = [tree];
  const found: Array<{ src: string; start: number; end: number }> = [];
  // Unique sources with their decoded size, budgeted before any encoder runs.
  const images = new Map<string, { file: File; pixels: number }>();
  let pixels = 0;
  while (nodes.length) {
    const node = nodes.pop()!;
    if ("childNodes" in node)
      for (const child of node.childNodes) nodes.push(child);
    if (!("tagName" in node) || node.tagName !== "img") continue;
    const src = node.attrs.find((a) => a.name === "src")?.value;
    const loc = node.sourceCodeLocation?.attrs?.src;
    const match =
      src &&
      /^data:(image\/(?:png|jpeg|webp|avif));base64,([\da-z+/=\s]+)$/i.exec(
        src,
      );
    if (!src || !loc || !match) continue;
    found.push({ src, start: loc.startOffset, end: loc.endOffset });
    if (images.has(src)) continue;
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
    const info = inspectRaster(bytes);
    pixels += info.width * info.height;
    if (pixels > 120_000_000 || images.size >= 100)
      throw new Error("PAGE_TOO_LARGE");
    images.set(src, { file: new File([bytes], "embedded", { type: match[1].toLowerCase() }), pixels: info.width * info.height });
  }
  // Images are independent: overlap their decoding and encoding in bounded batches.
  const urls = new Map<string, string>();
  const convert = async ([src, { file }]: [string, { file: File }]) => {
    const out = await optimize(file);
    urls.set(src, out === file ? src : await dataUrl(out));
  };
  let batch: Array<[string, { file: File; pixels: number }]> = [];
  let batchPixels = 0;
  for (const image of images) {
    if (batch.length && (batch.length === BATCH_IMAGES || batchPixels + image[1].pixels > BATCH_PIXELS)) {
      await Promise.all(batch.map(convert));
      batch = []; batchPixels = 0;
    }
    batch.push(image);
    batchPixels += image[1].pixels;
  }
  await Promise.all(batch.map(convert));
  const edits = found
    .filter(({ src }) => urls.get(src) !== src)
    .map(({ src, start, end }) => ({ start, end, value: 'src="' + urls.get(src) + '"' }));
  if (!edits.length) return html;
  const chunks: string[] = [];
  let offset = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    chunks.push(source.slice(offset, edit.start), edit.value);
    offset = edit.end;
  }
  chunks.push(source.slice(offset));
  return new File(chunks, html.name, {
    type: html.type,
    lastModified: html.lastModified,
  });
}
