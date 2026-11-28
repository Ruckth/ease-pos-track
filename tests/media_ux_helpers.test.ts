import assert from "node:assert/strict";
import test from "node:test";
import {
  MEDIA_ANNOTATION_MAX_LENGTH,
  MEDIA_IMAGE_LIMIT,
  MEDIA_VIDEO_LIMIT,
  carouselArrowDirection,
  computeMediaCapacity,
  groupTimeMarks,
  mediaUxCopy,
  partitionMediaFiles,
  pinAnchorPercent,
  shouldCarouselHandleKey,
  stepDragCueState,
  summarizeAnnotationUpdate,
  validateCapturedPhoto,
} from "../src/lib/media-ux-copy";
import { MEDIA_POLICY } from "../shared/ticket-contracts";
import { IMAGE_SOURCE_BYTES } from "../shared/image-optimization";
import type { Annotation } from "../src/lib/types";

function fakeFile(name: string, type: string, size = 1024): File {
  const file = new File([new Uint8Array(Math.min(size, 16))], name, { type });
  if (size > 16) {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

test("UX-095: computeMediaCapacity exposes used and remaining counts by media type", () => {
  const items = [
    ...Array.from({ length: 10 }, () => ({ isVideo: false })),
    { isVideo: true },
  ];
  const cap = computeMediaCapacity(items);
  assert.deepEqual(cap, {
    imageUsed: 10,
    imageLimit: MEDIA_IMAGE_LIMIT,
    imageRemaining: 0,
    videoUsed: 1,
    videoLimit: MEDIA_VIDEO_LIMIT,
    videoRemaining: 2,
  });
  assert.equal(mediaUxCopy("en").photoSlots(10, 10, 0), "Photos 10/10 · 0 left");
  assert.equal(mediaUxCopy("en").videoSlots(1, 3, 2), "Videos 1/3 · 2 left");
  assert.equal(mediaUxCopy("th").photoSlots(10, 10, 0), "รูป 10/10 · เหลือ 0");
  assert.equal(mediaUxCopy("th").videoSlots(1, 3, 2), "วิดีโอ 1/3 · เหลือ 2");
});

test("UX-099: partitionMediaFiles summarizes exact accepted and rejected counts in mixed batches", () => {
  const existing = Array.from({ length: 8 }, () => ({ isVideo: false }));
  const batch = [
    fakeFile("ok-1.jpg", "image/jpeg", 500),
    fakeFile("ok-2.jpg", "image/jpeg", 500),
    fakeFile("over-limit.jpg", "image/jpeg", 500),
    fakeFile("clip.mp4", "video/mp4", 10_000),
    fakeFile("notes.pdf", "application/pdf", 500),
  ];
  const result = partitionMediaFiles(batch, existing);
  assert.equal(result.accepted.length, 3);
  assert.deepEqual(
    result.rejected.map((entry) => [entry.file.name, entry.code]),
    [
      ["over-limit.jpg", "imageLimit"],
      ["notes.pdf", "imageVideoOnly"],
    ],
  );
  assert.equal(mediaUxCopy("en").selectionSummary(3, 2), "3 added, 2 skipped");
  assert.equal(mediaUxCopy("th").selectionSummary(3, 2), "เพิ่มแล้ว 3 ไฟล์ ข้าม 2 ไฟล์");
});

test("UX-105: validateCapturedPhoto checks photo slot and source size before approval", () => {
  const fullPhotos = Array.from({ length: MEDIA_IMAGE_LIMIT }, () => ({ isVideo: false }));
  assert.equal(validateCapturedPhoto({ type: "image/jpeg", size: 1024 }, fullPhotos), "imageLimit");
  assert.equal(
    validateCapturedPhoto({ type: "image/jpeg", size: IMAGE_SOURCE_BYTES + 1 }, []),
    "sourceImageTooLarge",
  );
  assert.equal(validateCapturedPhoto({ type: "image/jpeg", size: 2048 }, []), null);
});

test("UX-109, UX-110, UX-125: note limits, localized target captions, and draft delete copy", () => {
  assert.equal(MEDIA_ANNOTATION_MAX_LENGTH, MEDIA_POLICY.maxAnnotationTextLength);
  assert.equal(MEDIA_ANNOTATION_MAX_LENGTH, 2000);

  const th = mediaUxCopy("th");
  const thVideoCaption = th.videoTargetCaption(2, "0:17");
  assert.match(thVideoCaption, /2/);
  assert.match(thVideoCaption, /0:17/);
  assert.doesNotMatch(thVideoCaption, /\b(at|video|image|photo)\b/i);

  const en = mediaUxCopy("en");
  assert.equal(en.videoTargetCaption(2, "0:17"), "Video 2 at 0:17");
  assert.equal(en.photoTargetCaption(1), "Photo 1");

  // Draft deletion copy never promises Undo or recovery.
  assert.doesNotMatch(en.draftDeleteConfirm(3), /\bundo\b/i);
  assert.match(en.draftDeleteConfirm(3), /permanently/i);
  assert.doesNotMatch(th.draftDeleteConfirm(3), /เลิกทำ/);
});

test("UX-119: groupTimeMarks clusters colocated video timestamps into an accessible group", () => {
  const mk = (id: string, label: number, time: number): Annotation => ({
    id,
    label,
    mediaIndex: 0,
    kind: "time",
    x: 0.5,
    y: 0.5,
    time,
    text: `Note ${label}`,
    createdAt: label,
  });
  const marks = [mk("a", 1, 17), mk("b", 2, 17.2), mk("c", 3, 17.5), mk("d", 4, 45)];
  const clusters = groupTimeMarks(marks, 60);
  assert.equal(clusters.length, 2);
  assert.deepEqual(
    clusters[0].marks.map((m) => m.label),
    [1, 2, 3],
  );
  assert.deepEqual(
    clusters[1].marks.map((m) => m.label),
    [4],
  );
});

test("UX-130 & UX-132: summarizeAnnotationUpdate separates timestamp shifts from position shifts and flags long diffs", () => {
  const timeOnly = summarizeAnnotationUpdate(
    "updated",
    { x: 0.5, y: 0.5, time: 17, text: "Same" },
    { x: 0.5, y: 0.5, time: 24, text: "Same" },
  );
  assert.equal(timeOnly.timeChanged, true);
  assert.equal(timeOnly.previousTime, 17);
  assert.equal(timeOnly.nextTime, 24);
  assert.equal(timeOnly.positionChanged, false);
  assert.equal(timeOnly.textTruncated, false);

  const posOnly = summarizeAnnotationUpdate(
    "updated",
    { x: 0.2, y: 0.5, time: 17, text: "Same" },
    { x: 0.8, y: 0.5, time: 17, text: "Same" },
  );
  assert.equal(posOnly.positionChanged, true);
  assert.equal(posOnly.timeChanged, false);

  const prefix = "a".repeat(82);
  const longText = summarizeAnnotationUpdate(
    "updated",
    { x: 0.5, y: 0.5, text: `${prefix} before` },
    { x: 0.5, y: 0.5, text: `${prefix} after` },
  );
  assert.equal(longText.textChanged, true);
  assert.equal(longText.textTruncated, true);

  assert.equal(mediaUxCopy("en").timeChanged("0:17", "0:24"), "time 0:17 → 0:24");
  assert.equal(mediaUxCopy("th").timeChanged("0:17", "0:24"), "เวลา 0:17 → 0:24");
});

test("UX-135: carousel key handling honors configured axis and ignores interactive controls", () => {
  assert.equal(carouselArrowDirection("ArrowLeft", "horizontal"), "prev");
  assert.equal(carouselArrowDirection("ArrowRight", "horizontal"), "next");
  assert.equal(carouselArrowDirection("ArrowUp", "horizontal"), null);
  assert.equal(carouselArrowDirection("ArrowUp", "vertical"), "prev");
  assert.equal(carouselArrowDirection("ArrowDown", "vertical"), "next");
  assert.equal(carouselArrowDirection("ArrowLeft", "vertical"), null);

  assert.equal(
    shouldCarouselHandleKey({
      keyboardNavigation: true,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isCarouselRoot: false,
      isCarouselNav: true,
      inInteractiveControl: false,
    }),
    true,
  );
  assert.equal(
    shouldCarouselHandleKey({
      keyboardNavigation: true,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isCarouselRoot: false,
      isCarouselNav: false,
      inInteractiveControl: true,
    }),
    false,
  );
  assert.equal(
    shouldCarouselHandleKey({
      keyboardNavigation: true,
      defaultPrevented: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      isCarouselRoot: false,
      isCarouselNav: false,
      inInteractiveControl: false,
    }),
    false,
  );
});

test("bilingual copy covers EN and TH cleanly with distinct strings", () => {
  const en = mediaUxCopy("en");
  const th = mediaUxCopy("th");
  assert.notEqual(en.makeCover, th.makeCover);
  assert.notEqual(en.retryCamera, th.retryCamera);
  assert.notEqual(en.retakePhoto, th.retakePhoto);
  assert.notEqual(en.usePhoto, th.usePhoto);
  assert.notEqual(en.retryFile, th.retryFile);
  assert.notEqual(en.inspectImage, th.inspectImage);
  assert.notEqual(en.zoomReset, th.zoomReset);
  assert.notEqual(en.showFullText, th.showFullText);
});

test("UX-101: stepDragCueState keeps nested depth synchronized across inside, outside, and null relatedTarget leaves", () => {
  let state = { depth: 0, active: false };
  // Enter container -> enter child -> leave container to child (inside) -> leave child to outside.
  state = stepDragCueState(state, { type: "enter" });
  assert.deepEqual(state, { depth: 1, active: true });
  state = stepDragCueState(state, { type: "enter" });
  assert.deepEqual(state, { depth: 2, active: true });
  state = stepDragCueState(state, { type: "leave", targetPosition: "inside" });
  assert.deepEqual(state, { depth: 1, active: true });
  state = stepDragCueState(state, { type: "leave", targetPosition: "outside" });
  assert.deepEqual(state, { depth: 0, active: false });

  // Nested dragleave with relatedTarget=null keeps cue active until depth hits 0.
  state = stepDragCueState(state, { type: "enter" });
  state = stepDragCueState(state, { type: "enter" });
  state = stepDragCueState(state, { type: "leave", targetPosition: "unknown" });
  assert.deepEqual(state, { depth: 1, active: true });
  state = stepDragCueState(state, { type: "leave", targetPosition: "unknown" });
  assert.deepEqual(state, { depth: 0, active: false });

  // External leave always resets even if an unmounted child left depth > 1.
  state = stepDragCueState({ depth: 3, active: true }, { type: "leave", targetPosition: "outside" });
  assert.deepEqual(state, { depth: 0, active: false });

  // Reversed dragleave(inside) before dragenter never flashes off.
  state = stepDragCueState({ depth: 1, active: true }, { type: "leave", targetPosition: "inside" });
  assert.deepEqual(state, { depth: 0, active: true });
  state = stepDragCueState(state, { type: "enter" });
  assert.deepEqual(state, { depth: 1, active: true });
  state = stepDragCueState(state, { type: "reset" });
  assert.deepEqual(state, { depth: 0, active: false });
});

test("UX-123: pinAnchorPercent anchors corners flush and interior centered without clipping", () => {
  assert.equal(pinAnchorPercent(0), 0);
  assert.equal(pinAnchorPercent(0.5), 50);
  assert.equal(pinAnchorPercent(1), 100);
  assert.equal(pinAnchorPercent(-0.2), 0);
  assert.equal(pinAnchorPercent(1.4), 100);
});
