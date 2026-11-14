import { MEDIA_POLICY } from "./ticket-contracts";
const IMAGE_MAX_BYTES = MEDIA_POLICY.image.maxBytes;
const VIDEO_MAX_BYTES = MEDIA_POLICY.video.maxBytes;
export const MAX_MEDIA_FILES = MEDIA_POLICY.image.maxCount + MEDIA_POLICY.video.maxCount;

export function validateFiles(files: Array<{ name: string; size: number; type: string }>) {
  const images = files.filter((file) => file.type.startsWith("image/"));
  const videos = files.filter((file) => file.type.startsWith("video/"));
  if (images.length + videos.length !== files.length) throw new Error("IMAGE_VIDEO_ONLY");
  if (images.length > 10 || videos.length > 3) throw new Error("MEDIA_LIMIT_EXCEEDED");
  if (images.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > IMAGE_MAX_BYTES)) {
    throw new Error("IMAGE_TOO_LARGE");
  }
  if (videos.some((file) => !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > VIDEO_MAX_BYTES)) {
    throw new Error("VIDEO_TOO_LARGE");
  }
  if (files.some((file) => !file.name.trim() || file.name.length > 255 || file.type.length > 100)) {
    throw new Error("INVALID_FILE_METADATA");
  }
}

export function validateMediaItems(
  media: Array<{ key: string; name: string; size: number; type: string; url: string }>,
) {
  validateFiles(media);
  if (media.some((item) => !item.key.trim() || !item.url.startsWith("https://"))) {
    throw new Error("INVALID_MEDIA_REFERENCE");
  }
}

export function fileSignature(file: { name: string; size: number; type: string }) {
  return `${file.name}\u0000${file.size}\u0000${file.type}`;
}

export function sameFiles(
  expected: Array<{ name: string; size: number; type: string }>,
  actual: Array<{ name: string; size: number; type: string }>,
) {
  const left = expected.map(fileSignature).sort();
  const right = actual.map(fileSignature).sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

