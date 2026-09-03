import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareTicketImages } from "../scripts/ticket/images";
import { TicketCliError } from "../scripts/ticket/errors";

test("image inputs load original local files and HTTPS links without transforming them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ticket-images-"));
  try {
    const localPath = join(directory, "local.png");
    const localBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await writeFile(localPath, localBytes);
    const remoteBytes = Buffer.from([0xff, 0xd8, 0xff, 4, 5, 6]);

    const images = await prepareTicketImages(
      [localPath, "https://images.example.com/remote.jpg"],
      async () => new Response(remoteBytes, { status: 200, headers: { "content-type": "image/jpeg" } }),
    );

    assert.equal(images.length, 2);
    assert.deepEqual(Buffer.from(await images[0].arrayBuffer()), localBytes);
    assert.equal(images[0].name, "local.png");
    assert.equal(images[0].type, "image/png");
    assert.deepEqual(Buffer.from(await images[1].arrayBuffer()), remoteBytes);
    assert.equal(images[1].name, "remote.jpg");
    assert.equal(images[1].type, "image/jpeg");
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
