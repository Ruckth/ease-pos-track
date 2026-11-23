import { inspectRaster } from "./image-optimization";

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
  const edits: Array<{ start: number; end: number; value: string }> = [];
  const cache = new Map<string, string>();
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
    let url = cache.get(src);
    if (!url) {
      const raw = atob(match[2]);
      const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const info = inspectRaster(bytes);
      pixels += info.width * info.height;
      if (pixels > 120_000_000 || cache.size >= 100)
        throw new Error("PAGE_TOO_LARGE");
      const extracted = new File([bytes], "embedded", {
        type: match[1].toLowerCase(),
      });
      const out = await optimize(extracted);
      if (out === extracted) {
        cache.set(src, src);
        continue;
      }
      const encoded = new Uint8Array(await out.arrayBuffer());
      let binary = "";
      for (let i = 0; i < encoded.length; i += 8192)
        binary += String.fromCharCode(...encoded.subarray(i, i + 8192));
      url = "data:" + out.type + ";base64," + btoa(binary);
      cache.set(src, url);
    }
    if (url !== src)
      edits.push({
        start: loc.startOffset,
        end: loc.endOffset,
        value: 'src="' + url + '"',
      });
  }
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
