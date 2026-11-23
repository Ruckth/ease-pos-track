import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";

export const imageTransfer = v.union(v.bytes(), v.array(v.id("imageChunks")));
type Transfer = ArrayBuffer | Id<"imageChunks">[];

// Node actions have a 5 MiB serialized argument/result limit, including base64.
// Keep typical files inline. Database documents must each fit within 1 MiB.
const CHUNK_BYTES = 512 * 1024;
// Deployments cap bytes written per second (4 MiB on the local backend); larger
// transfers are paced to about half of that so the page's own writes still fit.
const CHUNK_INTERVAL_MS = 250;

export async function packImage(
  ctx: ActionCtx,
  bytes: ArrayBuffer,
): Promise<Transfer> {
  if (bytes.byteLength <= 3 * 1024 * 1024) return bytes;
  const chunks: Id<"imageChunks">[] = [];
  for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
    if (start) await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS));
    chunks.push(
      await ctx.runMutation(internal.image_chunks.put, {
        bytes: bytes.slice(start, start + CHUNK_BYTES),
      }),
    );
  }
  return chunks;
}

export async function unpackImage(
  ctx: ActionCtx,
  payload: Transfer,
): Promise<ArrayBuffer> {
  if (!Array.isArray(payload)) return payload;
  const chunks: Uint8Array[] = [];
  for (const id of payload)
    chunks.push(
      new Uint8Array(await ctx.runMutation(internal.image_chunks.take, { id })),
    );
  const result = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  let start = 0;
  for (const chunk of chunks) {
    result.set(chunk, start);
    start += chunk.length;
  }
  return result.buffer;
}
