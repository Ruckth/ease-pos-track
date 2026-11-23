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
  const { inspectRaster } = await import("../shared/image-optimization");
  const { rasterTraits, withoutMetadata } = await import("../shared/raster-structure");
  const source = await sharp({ create: { width: 140, height: 60, channels: 3, background: "#418761" } })
    .jpeg().withMetadata({ orientation: 1 }).toBuffer();
  const clean = withoutMetadata(new Uint8Array(source), "image/jpeg");
  assert(clean.length < source.length && rasterTraits(clean, "image/jpeg").clean);
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

// ---------------------------------------------------------------------------
// Photos, original-size files, animations and formats

const photoJpeg = async (width: number, height: number) => {
  const { photographicPixels } = await import("./fixtures/photo");
  return sharp(Buffer.from(photographicPixels(width, height)), { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 95 }).withMetadata({ exif: { IFD0: { Make: "Fixture camera" } } }).toBuffer();
};

test("a resized phone photo becomes a much smaller lossy image whose brightness detail is intact", async () => {
  const { optimizeImage } = await import("../shared/node/optimize-image");
  const { faithfulPixels, pixelPolicy } = await import("../shared/image-optimization");
  const source = await photoJpeg(2000, 1400);
  const output = await optimizeImage(new File([new Uint8Array(source)], "counter.jpg", { type: "image/jpeg" }));
  assert.notEqual(output.type, "image/png");
  assert.ok(output.size < source.length / 4, `${output.size} of ${source.length} bytes`);
  const bytes = Buffer.from(await output.arrayBuffer());
  const meta = await sharp(bytes).metadata();
  assert.deepEqual([meta.width, meta.height, meta.exif], [1543, 1080, undefined]);
  const reference = await sharp(source).resize(1543, 1080).ensureAlpha().raw().toBuffer();
  const pixels = await sharp(bytes).ensureAlpha().raw().toBuffer();
  assert.equal(pixelPolicy(reference, 1543).photo, true);
  assert(faithfulPixels(reference, pixels, true));
});

test("the photo tolerance applies only to opaque photographic content, never to UI or transparency", async () => {
  const { faithfulPixels, pixelPolicy } = await import("../shared/image-optimization");
  const { photographicPixels } = await import("./fixtures/photo");
  const photo = await sharp(Buffer.from(photographicPixels(300, 200)), { raw: { width: 300, height: 200, channels: 3 } }).ensureAlpha().raw().toBuffer();
  assert.deepEqual([pixelPolicy(photo, 300).opaque, pixelPolicy(photo, 300).photo], [true, true]);
  const ui = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/><text x="4" y="30" font-size="13" fill="#d22">Total 1,234.50</text></svg>')).ensureAlpha().raw().toBuffer();
  assert.equal(pixelPolicy(ui, 300).photo, false);
  const translucent = Buffer.from(photo);
  translucent[3] = 254;
  assert.equal(pixelPolicy(translucent, 300).photo, false);
  // A brightness change beyond 24 levels fails even with the photo tolerance.
  const darker = Buffer.from(photo);
  for (let c = 0; c < 3; c++) darker[c] = Math.max(0, darker[c] - 40);
  assert.equal(faithfulPixels(photo, darker, true), false);
});

test("at the original size, metadata is removed without growing the file", async () => {
  const { optimizeImage } = await import("../shared/node/optimize-image");
  const { pngChunk, withJpegSegment, withPngChunk } = await import("./fixtures/rasters");
  const { photographicPixels } = await import("./fixtures/photo");
  const raw = sharp(Buffer.from(photographicPixels(400, 300)), { raw: { width: 400, height: 300, channels: 3 } });
  const png = withPngChunk(new Uint8Array(await raw.clone().png().toBuffer()), pngChunk("tEXt", Buffer.from("Comment\0Front counter")));
  const jpeg = withJpegSegment(new Uint8Array(await raw.clone().jpeg({ quality: 80 }).toBuffer()), 0xfe, "Front counter");
  for (const [source, type] of [[png, "image/png"], [jpeg, "image/jpeg"]] as const) {
    const output = await optimizeImage(new File([source], "counter", { type }));
    const bytes = new Uint8Array(await output.arrayBuffer());
    assert.ok(bytes.length < source.length, `${type}: ${bytes.length} of ${source.length} bytes`);
    assert.equal(Buffer.from(bytes).includes(Buffer.from("Front counter")), false);
  }
});

const frames = (colors: string[], width: number, height: number) =>
  Promise.all(colors.map(color => sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer()));

test("a single-frame GIF is a still image; animations keep every frame and delay", async () => {
  const { optimizeImage } = await import("../shared/node/optimize-image");
  const still = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#c33" } }).gif().toBuffer();
  const prepared = await optimizeImage(new File([new Uint8Array(still)], "still.gif", { type: "image/gif" }));
  assert.equal((await sharp(await prepared.arrayBuffer()).metadata()).pages ?? 1, 1);

  const small = await sharp(await frames(["#f80", "#08f", "#0a4"], 60, 40), { join: { animated: true } }).gif({ delay: [70, 120, 300], loop: 2 }).toBuffer();
  const large = await sharp(await frames(["#f80", "#08f", "#0a4"], 2400, 120), { join: { animated: true } }).gif({ delay: [70, 120, 300], loop: 2 }).toBuffer();
  for (const [source, width] of [[small, 60], [large, 1920]] as const) {
    const output = await optimizeImage(new File([new Uint8Array(source)], "recording.gif", { type: "image/gif" }));
    const meta = await sharp(await output.arrayBuffer(), { animated: true }).metadata();
    assert.deepEqual([meta.width, meta.pages, meta.delay, meta.loop], [width, 3, [70, 120, 300], 2], output.type);
  }
});

test("animations that cannot be kept, and HEIC this runtime cannot decode, have their own error codes", async () => {
  const { optimizeImage } = await import("../shared/node/optimize-image");
  const { apng } = await import("./fixtures/rasters");
  const wide = await apng({ width: 2000, height: 20 });
  await assert.rejects(optimizeImage(new File([wide], "wide.png", { type: "image/png" })), /IMAGE_ANIMATION_UNSUPPORTED/);
  const kept = await optimizeImage(new File([await apng()], "small.png", { type: "image/png" }));
  assert.equal(kept.type, "image/png");
  if (process.platform !== "darwin") return;
  const heic = await heicFixture();
  await assert.rejects(optimizeImage(new File([heic], "photo.heic", { type: "image/heic" })), /IMAGE_FORMAT_UNSUPPORTED/);
});

/** macOS writes HEIC with its own `sips`; Sharp's prebuilt binaries cannot. */
async function heicFixture() {
  const { execFileSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "ticket-heic-fixture-"));
  try {
    await writeFile(join(directory, "in.png"), await sharp({ create: { width: 64, height: 48, channels: 3, background: "#2a6" } }).png().toBuffer());
    execFileSync("/usr/bin/sips", ["-s", "format", "heic", join(directory, "in.png"), "--out", join(directory, "out.heic")], { stdio: "ignore" });
    return new Uint8Array(await (await import("node:fs/promises")).readFile(join(directory, "out.heic")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Staff CLI and provider callback byte verification

test("the staff CLI converts HEIC on macOS and verifies every prepared file before upload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ticket-cli-images-"));
  try {
    const photo = join(directory, "photo.jpg");
    await writeFile(photo, await photoJpeg(640, 480));
    // Retries prepare byte-identical files, so recorded uploads match the retry.
    const [first, second] = [await prepareTicketImages([photo]), await prepareTicketImages([photo])];
    assert.deepEqual(Buffer.from(await first[0].arrayBuffer()), Buffer.from(await second[0].arrayBuffer()));

    // An optimizer whose output keeps a comment is caught by the independent check.
    const { withJpegSegment } = await import("./fixtures/rasters");
    const leaky = async (file: File) => new File([withJpegSegment(new Uint8Array(await file.arrayBuffer()), 0xfe, "note")], file.name, { type: "image/jpeg" });
    await assert.rejects(prepareTicketImages([photo], fetch, leaky), (error: unknown) => error instanceof TicketCliError && error.code === "IMAGE_INVALID");

    const heicPath = join(directory, "photo.heic");
    if (process.platform === "darwin") {
      await writeFile(heicPath, await heicFixture());
      const [converted] = await prepareTicketImages([heicPath]);
      assert.notEqual(converted.type, "image/heic");
      assert.deepEqual([(await sharp(await converted.arrayBuffer()).metadata()).width], [64]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider callback rejects stored bytes with comments, vendor records, trailing bytes or a non-image icon", async () => {
  const { validStoredImage } = await import("../server/validate-upload-image");
  const { concat, icon, pngChunk, withJpegSegment, withPngChunk } = await import("./fixtures/rasters");
  const check = (bytes: Uint8Array, type: string) =>
    validStoredImage({ key: "owned", ufsUrl: "https://demo.ufs.sh/f/owned", size: bytes.length, type }, async () => new Response(Buffer.from(bytes)));
  const jpeg = new Uint8Array(await sharp({ create: { width: 20, height: 10, channels: 3, background: "#587" } }).jpeg().toBuffer());
  const png = new Uint8Array(await sharp({ create: { width: 20, height: 10, channels: 3, background: "#587" } }).png().toBuffer());
  assert.equal(await check(jpeg, "image/jpeg"), true);
  assert.equal(await check(await icon(), "image/x-icon"), true);
  assert.equal(await check(withJpegSegment(jpeg, 0xfe, "Counter 2"), "image/jpeg"), false);
  assert.equal(await check(withJpegSegment(jpeg, 0xef, "VENDOR settings"), "image/jpeg"), false);
  assert.equal(await check(concat(jpeg, Buffer.from("extra")), "image/jpeg"), false);
  assert.equal(await check(withPngChunk(png, pngChunk("prVt", Buffer.from("settings"))), "image/png"), false);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header[6] = header[7] = 16;
  header.writeUInt32LE(40, 14);
  header.writeUInt32LE(22, 18);
  assert.equal(await check(concat(header, Buffer.from("Opening hours: 9 to 5".padEnd(40, " "))), "image/x-icon"), false);
});
