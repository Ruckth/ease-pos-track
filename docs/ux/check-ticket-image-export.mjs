import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { chromium } from "playwright";

const marker = "synthetic-source-metadata";
const crop = { x: 2, y: 1, width: 4, height: 3 };
const redaction = { x: 1, y: 1, width: 2, height: 1 };
const pins = [
  { id: "included", x: 4, y: 3 },
  { id: "outside", x: 1, y: 2 },
  { id: "right-edge", x: 6, y: 2 },
];

function pngTextChunk(keyword, value) {
  const data = Buffer.from(`${keyword}\0${value}`, "latin1");
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("tEXt", 4, "ascii");
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return chunk;
}

function pngChunkTypes(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  const types = [];
  for (let offset = 8; offset < bytes.length;) {
    const end = offset + bytes.readUInt32BE(offset) + 12;
    assert.ok(end <= bytes.length, "PNG chunk fits in the file");
    assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)));
    types.push(bytes.toString("ascii", offset + 4, offset + 8));
    offset = end;
  }
  assert.equal(types.at(-1), "IEND");
  return types;
}

const sourceColor = (x, y) => [20 + x * 17, 30 + y * 23, 90, 255];
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const sourceBase64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 6;
    const context = canvas.getContext("2d");
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        context.fillStyle = `rgb(${20 + x * 17}, ${30 + y * 23}, 90)`;
        context.fillRect(x, y, 1, 1);
      }
    }
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const original = Buffer.from(sourceBase64, "base64");
  assert.equal(original.toString("ascii", 12, 16), "IHDR");
  const afterHeader = 8 + original.readUInt32BE(8) + 12;
  const source = Buffer.concat([
    original.subarray(0, afterHeader),
    pngTextChunk("Comment", marker),
    original.subarray(afterHeader),
  ]);
  assert.ok(pngChunkTypes(source).includes("tEXt"));
  assert.ok(source.includes(marker));

  const result = await page.evaluate(async ({ sourceBase64, crop, redaction, pins }) => {
    const source = new Image();
    source.src = `data:image/png;base64,${sourceBase64}`;
    await source.decode();

    const raster = document.createElement("canvas");
    raster.width = crop.width;
    raster.height = crop.height;
    const context = raster.getContext("2d");
    context.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    context.fillStyle = "#000";
    context.fillRect(redaction.x, redaction.y, redaction.width, redaction.height);

    const blob = await new Promise((resolve) => raster.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("PNG export failed");
    const decoded = await createImageBitmap(blob);
    const verification = document.createElement("canvas");
    verification.width = decoded.width;
    verification.height = decoded.height;
    const verificationContext = verification.getContext("2d");
    verificationContext.drawImage(decoded, 0, 0);
    decoded.close();

    const projectedPins = pins
      .map(({ id, x, y }) => ({ id, x: x - crop.x, y: y - crop.y }))
      .filter(({ x, y }) => x >= 0 && x < crop.width && y >= 0 && y < crop.height)
      .map(({ id, x, y }) => ({ id, x: x / crop.width, y: y / crop.height }));

    return {
      width: verification.width,
      height: verification.height,
      pixels: [...verificationContext.getImageData(0, 0, verification.width, verification.height).data],
      bytes: [...new Uint8Array(await blob.arrayBuffer())],
      pins: projectedPins,
    };
  }, { sourceBase64: source.toString("base64"), crop, redaction, pins });

  assert.deepEqual([result.width, result.height], [4, 3]);
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const offset = (y * result.width + x) * 4;
      const expected = y === 1 && (x === 1 || x === 2)
        ? [0, 0, 0, 255]
        : sourceColor(x + crop.x, y + crop.y);
      assert.deepEqual(result.pixels.slice(offset, offset + 4), expected, `pixel (${x}, ${y})`);
    }
  }
  const exported = Buffer.from(result.bytes);
  const chunks = pngChunkTypes(exported);
  assert.ok(!chunks.some((type) => ["tEXt", "zTXt", "iTXt"].includes(type)));
  assert.ok(!exported.includes(marker));
  assert.deepEqual(result.pins, [{ id: "included", x: 0.5, y: 2 / 3 }]);

  console.log(JSON.stringify({
    chromium: browser.version(),
    sourceDimensions: [8, 6],
    exportDimensions: [result.width, result.height],
    verifiedPixels: result.width * result.height,
    opaqueRedactedPixels: 2,
    sourceChunks: pngChunkTypes(source),
    exportChunks: chunks,
    sourceBytes: source.length,
    exportBytes: exported.length,
    projectedPins: result.pins,
  }, null, 2));
} finally {
  await browser.close();
}
