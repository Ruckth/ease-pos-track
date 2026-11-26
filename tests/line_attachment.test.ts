import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import { validateLineAttachment } from "../convex/adapters/line_attachment";
import { syntheticLineAiInput } from "../convex/adapters/line_ai_provider";

test("LINE attachment validation accepts supported image and PDF data and rejects disguises", async () => {
  const [png, pdf] = syntheticLineAiInput().files!;
  assert.deepEqual(await validateLineAttachment(png.bytes, "application/octet-stream"), png);
  assert.deepEqual(await validateLineAttachment(pdf.bytes, "application/pdf; charset=binary"), pdf);
  await assert.rejects(validateLineAttachment(png.bytes, "application/pdf"), /LINE_CONTENT_TYPE_MISMATCH/);
  await assert.rejects(validateLineAttachment(png.bytes.subarray(0, -1)), /LINE_CONTENT_MALFORMED/);
  await assert.rejects(validateLineAttachment(pdf.bytes.subarray(0, 60)), /LINE_CONTENT_MALFORMED/);
  await assert.rejects(validateLineAttachment(new Uint8Array(8 * 1024 * 1024 + 1)), /LINE_CONTENT_TOO_LARGE/);
});

test("PDF page limits apply to a compressed page tree", async () => {
  const pdf = await PDFDocument.create();
  for (let index = 0; index < 12; index += 1) pdf.addPage();
  assert.equal((await validateLineAttachment(await pdf.save())).mimeType, "application/pdf");
  assert.equal((await validateLineAttachment(await pdf.save({ useObjectStreams: false }))).mimeType, "application/pdf");
  pdf.addPage();
  await assert.rejects(validateLineAttachment(await pdf.save()), /LINE_CONTENT_PAGE_LIMIT/);
});

test("a large PDF metadata field exceeds the structure budget without reaching the provider", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  // pdf-lib writes text metadata as UTF-16 hexadecimal inside an object stream.
  pdf.setSubject("Sample metadata ".repeat(40_000));
  await assert.rejects(validateLineAttachment(await pdf.save()), /LINE_CONTENT_MALFORMED/);
});
