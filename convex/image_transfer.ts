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
const spaceChunkWrites = () => new Promise<void>(resolve => setTimeout(resolve, 250));

export async function packImage(
  ctx: ActionCtx,
  bytes: ArrayBuffer,
): Promise<Transfer> {
  if (bytes.byteLength <= 3 * 1024 * 1024) return bytes;
  const chunks: Id<"imageChunks">[] = [];
  for (let start = 0; start < bytes.byteLength; start += CHUNK_BYTES) {
    if (start) await spaceChunkWrites();
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
  // Taking a chunk deletes it, which also counts towards the write budget.
  // Read the short final chunk first to allocate the exact output size once.
  const lastIndex = payload.length - 1;
  if (lastIndex < 0) throw new Error("PAGE_PUBLISH_UNKNOWN");
  const last = await ctx.runMutation(internal.image_chunks.take, { id: payload[lastIndex] });
  const result = new Uint8Array(lastIndex * CHUNK_BYTES + last.byteLength);
  result.set(new Uint8Array(last), lastIndex * CHUNK_BYTES);
  for (let i = 0; i < lastIndex; i++) {
    await spaceChunkWrites();
    const bytes = await ctx.runMutation(internal.image_chunks.take, { id: payload[i] });
    result.set(new Uint8Array(bytes), i * CHUNK_BYTES);
  }
  return result.buffer;
}
