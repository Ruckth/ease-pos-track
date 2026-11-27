import { constants, Inflate } from "pako";
import { PDFArray, PDFCatalog, PDFName, PDFNumber, PDFPageLeaf, PDFPageTree, PDFParser, PDFRawStream } from "pdf-lib";

const maxPages = 12;
const maxStructureBytes = 2 * 1024 * 1024;
const maxStructureEntries = 20_000;
const maxPageTreeNodes = 1_024;

function malformed(): never {
  throw new Error("LINE_CONTENT_MALFORMED");
}

function decompressStructure(contents: Uint8Array, limit: number) {
  const inflater = new Inflate({ windowBits: 15 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  let complete = false;
  inflater.onEnd = status => { complete = status === constants.Z_OK; };
  inflater.onData = chunk => {
    if (typeof chunk === "string") return malformed();
    size += chunk.byteLength;
    if (size > limit) return malformed();
    chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
  };
  if (!inflater.push(contents, true) || !complete) return malformed();
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class AttachmentPdfParser extends PDFParser {
  private remainingBytes = maxStructureBytes;
  private remainingEntries = maxStructureEntries;

  // pdf-lib eagerly opens object and cross-reference streams. Supply already
  // decoded, bounded metadata so its parser never inflates these streams itself.
  override parseObject() {
    const object = super.parseObject();
    if (!(object instanceof PDFRawStream)) return object;
    const { dict, contents } = object;
    const type = dict.lookup(PDFName.of("Type"));
    const objectStream = type === PDFName.of("ObjStm");
    if (!objectStream && type !== PDFName.of("XRef")) return object;

    const filterName = PDFName.of("Filter");
    const filter = dict.lookup(filterName);
    const flate = filter === PDFName.of("FlateDecode")
      || (filter instanceof PDFArray && filter.size() === 1 && filter.lookup(0) === PDFName.of("FlateDecode"));
    if (dict.has(filterName) && !flate) return malformed();
    const decoded = flate ? decompressStructure(contents, this.remainingBytes) : contents;
    this.remainingBytes -= decoded.byteLength;
    if (this.remainingBytes < 0) return malformed();

    const integer = (key: string) => dict.lookup(PDFName.of(key), PDFNumber).asNumber();
    if (objectStream) {
      this.reserveEntries(integer("N"));
      const first = integer("First");
      if (!Number.isSafeInteger(first) || first < 0 || first > decoded.byteLength) return malformed();
    } else {
      const widths = dict.lookup(PDFName.of("W"), PDFArray);
      if (widths.size() !== 3) return malformed();
      let bytesPerEntry = 0;
      for (let index = 0; index < widths.size(); index++) {
        const width = widths.lookup(index, PDFNumber).asNumber();
        if (!Number.isSafeInteger(width) || width < 0 || width > 8) return malformed();
        bytesPerEntry += width;
      }
      const ranges = dict.lookupMaybe(PDFName.of("Index"), PDFArray);
      let entries = 0;
      if (ranges) {
        if (ranges.size() % 2 || ranges.size() > maxStructureEntries) return malformed();
        for (let index = 1; index < ranges.size(); index += 2) {
          const count = ranges.lookup(index, PDFNumber).asNumber();
          if (!Number.isSafeInteger(count) || count < 0) return malformed();
          entries += count;
        }
      } else entries = integer("Size");
      this.reserveEntries(entries);
      if (entries * bytesPerEntry > decoded.byteLength) return malformed();
    }

    dict.delete(filterName);
    dict.delete(PDFName.of("DecodeParms"));
    return PDFRawStream.of(dict, decoded);
  }

  private reserveEntries(count: number) {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.remainingEntries) return malformed();
    this.remainingEntries -= count;
  }
}

export async function validateLinePdf(bytes: Uint8Array) {
  let pages = 0;
  try {
    const tail = new TextDecoder().decode(bytes.subarray(-1024));
    if (!/%%EOF\s*$/.test(tail)) return malformed();
    const context = await new AttachmentPdfParser(bytes, Infinity, true).parseDocument();
    if (context.trailerInfo.Encrypt) return malformed();
    const catalog = context.lookup(context.trailerInfo.Root);
    if (!(catalog instanceof PDFCatalog)) return malformed();
    const nodes: (PDFPageTree | PDFPageLeaf)[] = [catalog.Pages()];
    const visited = new Set<PDFPageTree | PDFPageLeaf>();
    while (nodes.length && pages <= maxPages) {
      const node = nodes.pop()!;
      if (visited.has(node) || visited.size >= maxPageTreeNodes) return malformed();
      visited.add(node);
      if (node instanceof PDFPageLeaf) {
        pages++;
        continue;
      }
      const children = node.Kids();
      if (children.size() + nodes.length + visited.size > maxPageTreeNodes) return malformed();
      for (let i = 0; i < children.size(); i++) {
        const child = children.lookup(i);
        if (!(child instanceof PDFPageTree) && !(child instanceof PDFPageLeaf)) return malformed();
        nodes.push(child);
      }
    }
  } catch {
    return malformed();
  }
  if (pages < 1 || pages > maxPages) throw new Error("LINE_CONTENT_PAGE_LIMIT");
}
