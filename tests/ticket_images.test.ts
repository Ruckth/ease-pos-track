import sharp from "sharp";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTicketImages } from "../scripts/ticket/images";
import { TicketCliError } from "../scripts/ticket/errors";

test("image inputs decode local files and HTTPS links and preserve the displayed dimensions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ticket-images-"));
  try {
    const localPath = join(directory, "local.png");
    const localBytes = await sharp({create:{width:320,height:150,channels:4,background:"#0000"}}).png().toBuffer();
    await writeFile(localPath, localBytes);
    const remoteBytes = await sharp(localBytes).jpeg().toBuffer();

    const images = await prepareTicketImages(
      [localPath, "https://images.example.com/remote.jpg"],
      async () => new Response(new Uint8Array(remoteBytes), { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    assert.equal(images.length, 2);
    for (const image of images) {
      const meta=await sharp(await image.arrayBuffer()).metadata();
      assert.deepEqual([meta.width,meta.height],[320,150]);
      assert.equal(image.type, "image/"+meta.format);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("image inputs reject unsafe links, unsupported files, and more than ten images", async () => {
  const rejects = async (sources: string[], code: string) => {
    await assert.rejects(
      () => prepareTicketImages(sources, async () => new Response("text", { headers: { "content-type": "text/plain" } })),
      (error: unknown) => error instanceof TicketCliError && error.code === code,
    );
  };
  await rejects(["http://images.example.com/file.png"], "INVALID_IMAGE_SOURCE");
  await rejects(["https://images.example.com/file.txt"], "IMAGE_TYPE_UNSUPPORTED");
  await rejects(Array.from({ length: 11 }, (_, index) => `https://images.example.com/${index}.png`), "IMAGE_LIMIT_EXCEEDED");
});

test("the staff upload adapter uses an injected provider and never exposes provider error details", async () => {
  const { UploadThingTicketImages } = await import("../scripts/ticket/images");
  const file = new File(["image"], "fixture.png", { type: "image/png" });
  const adapter = new UploadThingTicketImages("fake-token", token => {
    assert.equal(token, "fake-token");
    return { uploadFiles: async files => {
      assert.deepEqual(files, [file]);
      return [{ data: { key: "fake-key", name: file.name, size: file.size, type: file.type, ufsUrl: "https://fixture.invalid/image.png" } }];
    } };
  });
  assert.deepEqual(await adapter.upload([file]), [{ key: "fake-key", name: file.name, size: file.size, type: file.type, url: "https://fixture.invalid/image.png" }]);
  const failed = new UploadThingTicketImages("fake-token", () => ({ uploadFiles: async () => { throw new Error("secret-key https://private.invalid token Ticket content"); } }));
  await assert.rejects(failed.upload([file]), error => error instanceof TicketCliError && !/secret-key|private.invalid|Ticket content/.test(error.message));
  const misconfigured = new UploadThingTicketImages("fake-token", () => { throw new Error("secret config"); });
  await assert.rejects(misconfigured.upload([file]), error => error instanceof TicketCliError && error.code === "UPLOAD_NOT_CONFIGURED" && !error.message.includes("secret config"));
});

test("normalization fits Full HD, respects EXIF rotation and removes capture metadata", async () => {
  const { optimizeImage } = await import("../shared/node/optimize-image");
  const input = await sharp({create:{width:3000,height:1500,channels:3,background:"#489"}})
    .jpeg().withMetadata({orientation:6}).toBuffer();
  const result=await optimizeImage(new File([new Uint8Array(input)],"camera.jpg",{type:"image/jpeg"}));
  const meta=await sharp(await result.arrayBuffer()).metadata();
  assert.deepEqual([meta.width,meta.height],[540,1080]);
  assert.equal(meta.exif,undefined);
  assert.equal(meta.orientation,undefined);
});

test("small text and transparent edges survive the selected encoding",async()=>{
  const { optimizeImage }=await import("../shared/node/optimize-image");
  const {faithfulPixels}=await import("../shared/image-optimization");
  const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><text x="3" y="26" font-size="12" fill="#12579a">Ticket POS-0007 / Total 1,234.50</text><path d="M0 40h319" stroke="#fe9300"/></svg>');
  const png=await sharp(svg).png().toBuffer();
  const output=await optimizeImage(new File([new Uint8Array(png)],"ui.png",{type:"image/png"}));
  assert.notEqual(output.type,"image/jpeg");
  const reference=await sharp(png).ensureAlpha().raw().toBuffer();
  const candidate=await sharp(await output.arrayBuffer()).ensureAlpha().raw().toBuffer();
  assert(faithfulPixels(reference,candidate));
  assert(output.size<=png.byteLength);
});

test("provider callback validates decoded pixels and metadata from bounded provider bytes",async()=>{
  const {validStoredImage}=await import("../server/validate-upload-image");
  const image=sharp({create:{width:20,height:10,channels:3,background:"#587"}});
  const check=async(bytes:Buffer,type:string) => validStoredImage({key:"owned",ufsUrl:"https://demo.ufs.sh/f/owned",size:bytes.length,type},async()=>new Response(new Uint8Array(bytes)));
  const png=await image.clone().png().toBuffer();
  assert(await check(png,"image/png"));
  assert.equal(await check(png,"image/webp"),false);
  assert.equal(await check(png.subarray(0,24),"image/png"),false);
  assert.equal(await check(await image.clone().withMetadata().jpeg().toBuffer(),"image/jpeg"),false);
});

test("a JPEG can shed metadata without a generation of quality loss", async () => {
  const { jpegWithoutMetadata, cleanJpeg, inspectRaster } = await import("../shared/image-optimization");
  const source = await sharp({ create: { width: 140, height: 60, channels: 3, background: "#418761" } })
    .jpeg().withMetadata({ orientation: 1 }).toBuffer();
  const clean = jpegWithoutMetadata(new Uint8Array(source));
  assert(clean);
  assert(clean.length < source.length && cleanJpeg(clean));
  assert.deepEqual(inspectRaster(clean), { type: "image/jpeg", width: 140, height: 60 });
  assert.equal((await sharp(clean).metadata()).exif, undefined);
  assert.deepEqual(await sharp(source).raw().toBuffer(), await sharp(clean).raw().toBuffer());
});

test("embedded images convert once each, in bounded batches, leaving other markup untouched", async () => {
  const { optimizeEmbeddedImages } = await import("../shared/html-images");
  const png = async (width: number, height: number, color: string) =>
    (await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()).toString("base64");
  const small = await Promise.all(["#111", "#222", "#333", "#444", "#555"].map(color => png(40, 30, color)));
  const large = await png(4000, 3200, "#666"); // 12.8 MP alone exceeds a batch's pixel budget
  const sources = [...small, small[0], large];
  const html = `<p>สรุป</p>${sources.map((data, index) => `<img alt="${index}" src="data:image/png;base64,${data}">`).join("")}<script>"data:image/png;base64,keep"</script>`;
  let active = 0, peak = 0;
  const calls: number[] = [];
  const output = await optimizeEmbeddedImages(new File([html], "page.html", { type: "text/html" }), async image => {
    active++; peak = Math.max(peak, active);
    calls.push(image.size);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return new File([new Uint8Array([1, 2, 3])], "out.webp", { type: "image/webp" });
  });
  const text = await output.text();
  assert.equal(calls.length, 6, "duplicate sources convert once");
  assert.equal(peak, 4);
  assert.equal(text.match(/src="data:image\/webp;base64,AQID"/g)?.length, 7);
  assert.ok(text.startsWith("<p>สรุป</p><img alt=\"0\" src="));
  assert.ok(text.endsWith('<script>"data:image/png;base64,keep"</script>'));
});
