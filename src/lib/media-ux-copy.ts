import type { Language } from "@/lib/i18n";
import type { Annotation } from "@/lib/types";
import { IMAGE_SOURCE_BYTES } from "../../shared/image-optimization";
import { MEDIA_POLICY } from "../../shared/ticket-contracts";

export const MEDIA_IMAGE_LIMIT = MEDIA_POLICY.image.maxCount;
export const MEDIA_VIDEO_LIMIT = MEDIA_POLICY.video.maxCount;
export const MEDIA_VIDEO_MAX_BYTES = MEDIA_POLICY.video.maxBytes;
export const MEDIA_ANNOTATION_MAX_LENGTH = MEDIA_POLICY.maxAnnotationTextLength;

export type MediaCopy = {
  photoSlots: (used: number, limit: number, remaining: number) => string;
  videoSlots: (used: number, limit: number, remaining: number) => string;
  makeCover: string;
  makeCoverNamed: (name: string) => string;
  pasteFromClipboard: string;
  pasteNoMedia: string;
  pasteUnavailable: string;
  dropActive: string;
  selectionSummary: (added: number, skipped: number) => string;
  showReasons: (count: number) => string;
  hideReasons: string;
  noteCount: (count: number) => string;
  retryCamera: string;
  capturingPhoto: string;
  capturedPreview: string;
  retakePhoto: string;
  usePhoto: string;
  draftModeStatus: string;
  imageModeStatus: string;
  videoModeStatus: string;
  moveModeStatus: string;
  characterCount: (used: number, limit: number) => string;
  photoTargetCaption: (number: number) => string;
  videoTargetCaption: (number: number, time: string) => string;
  videoFileTargetCaption: (number: number, name: string | undefined, time: string) => string;
  photoFileTargetCaption: (number: number, name: string | undefined) => string;
  activeMediaAnnouncement: (kind: "photo" | "video", number: number, total: number, name: string) => string;
  mediaLoadFailed: string;
  retryFile: string;
  inspectImage: string;
  inspectDialogTitle: (name: string) => string;
  zoomIn: string;
  zoomOut: string;
  zoomActual: string;
  zoomReset: string;
  zoomLevel: (percent: number, mode: "fit" | "zoom") => string;
  groupedNotesButton: (count: number, time: string) => string;
  groupedNotesHeading: (count: number, time: string) => string;
  closeGroup: string;
  draftDeleteConfirm: (label: number) => string;
  deletedAtLabel: (date: string) => string;
  showFullText: string;
  hideFullText: string;
  beforeLabel: string;
  afterLabel: string;
  timeChanged: (before: string, after: string) => string;
};

const copyByLanguage: Record<Language, MediaCopy> = {
  en: {
    photoSlots: (used, limit, remaining) => `Photos ${used}/${limit} · ${remaining} left`,
    videoSlots: (used, limit, remaining) => `Videos ${used}/${limit} · ${remaining} left`,
    makeCover: "Make cover",
    makeCoverNamed: (name) => `Make ${name} cover`,
    pasteFromClipboard: "Paste file",
    pasteNoMedia: "No photo or video found on the clipboard.",
    pasteUnavailable: "Unable to read from the clipboard.",
    dropActive: "Drop photos or videos to attach",
    selectionSummary: (added, skipped) =>
      skipped > 0 ? `${added} added, ${skipped} skipped` : `${added} added`,
    showReasons: (count) => `Show reasons (${count})`,
    hideReasons: "Hide reasons",
    noteCount: (count) => (count === 1 ? "1 note" : `${count} notes`),
    retryCamera: "Retry camera",
    capturingPhoto: "Capturing photo…",
    capturedPreview: "Captured photo preview",
    retakePhoto: "Retake",
    usePhoto: "Use photo",
    draftModeStatus: "Editing note",
    imageModeStatus: "Note placement mode · Tap the image or use arrow keys to place a pin.",
    videoModeStatus: "Note placement mode · Scrub to a frame, then tap the video or use arrow keys to place a pin.",
    moveModeStatus: "Moving note · Tap a new spot on this file or use arrow keys.",
    characterCount: (used, limit) => `${used.toLocaleString("en-US")} / ${limit.toLocaleString("en-US")}`,
    photoTargetCaption: (number) => `Photo ${number}`,
    videoTargetCaption: (number, time) => `Video ${number} at ${time}`,
    videoFileTargetCaption: (number, name, time) =>
      name ? `Video ${number} (${name}) at ${time}` : `Video ${number} at ${time}`,
    photoFileTargetCaption: (number, name) =>
      name ? `Photo ${number} (${name})` : `Photo ${number}`,
    activeMediaAnnouncement: (kind, number, total, name) =>
      `${kind === "video" ? "Video" : "Photo"} ${number} of ${total}: ${name}`,
    mediaLoadFailed: "This file could not be loaded.",
    retryFile: "Retry file",
    inspectImage: "Inspect image",
    inspectDialogTitle: (name) => `Inspect ${name}`,
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomActual: "100%",
    zoomReset: "Reset",
    zoomLevel: (percent, mode) => (mode === "fit" ? "Fit to view" : `${percent}%`),
    groupedNotesButton: (count, time) => `${count} notes at ${time}`,
    groupedNotesHeading: (count, time) => `${count} notes near ${time}`,
    closeGroup: "Close timestamp group",
    draftDeleteConfirm: (label) =>
      `Delete note ${label} permanently? Draft notes cannot be restored after removal.`,
    deletedAtLabel: (date) => `Deleted ${date}`,
    showFullText: "Show full text",
    hideFullText: "Hide full text",
    beforeLabel: "Before",
    afterLabel: "After",
    timeChanged: (before, after) => `time ${before} → ${after}`,
  },
  th: {
    photoSlots: (used, limit, remaining) => `รูป ${used}/${limit} · เหลือ ${remaining}`,
    videoSlots: (used, limit, remaining) => `วิดีโอ ${used}/${limit} · เหลือ ${remaining}`,
    makeCover: "ตั้งเป็นภาพปก",
    makeCoverNamed: (name) => `ตั้ง ${name} เป็นภาพปก`,
    pasteFromClipboard: "วางไฟล์",
    pasteNoMedia: "ไม่พบรูปหรือวิดีโอในคลิปบอร์ด",
    pasteUnavailable: "ไม่สามารถอ่านข้อมูลจากคลิปบอร์ดได้",
    dropActive: "วางรูปหรือวิดีโอเพื่อแนบไฟล์",
    selectionSummary: (added, skipped) =>
      skipped > 0 ? `เพิ่มแล้ว ${added} ไฟล์ ข้าม ${skipped} ไฟล์` : `เพิ่มแล้ว ${added} ไฟล์`,
    showReasons: (count) => `ดูสาเหตุ (${count})`,
    hideReasons: "ซ่อนสาเหตุ",
    noteCount: (count) => `${count} หมายเหตุ`,
    retryCamera: "ลองเปิดกล้องอีกครั้ง",
    capturingPhoto: "กำลังถ่ายรูป…",
    capturedPreview: "ตัวอย่างรูปที่ถ่าย",
    retakePhoto: "ถ่ายใหม่",
    usePhoto: "ใช้รูปนี้",
    draftModeStatus: "กำลังแก้ไขหมายเหตุ",
    imageModeStatus: "โหมดเพิ่มหมายเหตุ · แตะบนรูปหรือใช้ปุ่มลูกศรเพื่อวางหมุด",
    videoModeStatus: "โหมดเพิ่มหมายเหตุ · เลื่อนเลือกช่วงเวลา แล้วแตะบนวิดีโอหรือใช้ปุ่มลูกศรเพื่อวางหมุด",
    moveModeStatus: "กำลังย้ายหมายเหตุ · แตะตำแหน่งใหม่บนไฟล์นี้หรือใช้ปุ่มลูกศร",
    characterCount: (used, limit) => `${used.toLocaleString("th-TH")} / ${limit.toLocaleString("th-TH")}`,
    photoTargetCaption: (number) => `รูปที่ ${number}`,
    videoTargetCaption: (number, time) => `วิดีโอที่ ${number} เวลา ${time}`,
    videoFileTargetCaption: (number, name, time) =>
      name ? `วิดีโอที่ ${number} (${name}) เวลา ${time}` : `วิดีโอที่ ${number} เวลา ${time}`,
    photoFileTargetCaption: (number, name) =>
      name ? `รูปที่ ${number} (${name})` : `รูปที่ ${number}`,
    activeMediaAnnouncement: (kind, number, total, name) =>
      `${kind === "video" ? "วิดีโอ" : "รูป"}ที่ ${number} จาก ${total}: ${name}`,
    mediaLoadFailed: "ไม่สามารถโหลดไฟล์นี้ได้",
    retryFile: "ลองโหลดไฟล์อีกครั้ง",
    inspectImage: "ขยายดูรูป",
    inspectDialogTitle: (name) => `ขยายดู ${name}`,
    zoomIn: "ขยายเข้า",
    zoomOut: "ย่อออก",
    zoomActual: "100%",
    zoomReset: "รีเซ็ต",
    zoomLevel: (percent, mode) => (mode === "fit" ? "พอดีหน้าจอ" : `${percent}%`),
    groupedNotesButton: (count, time) => `${count} หมายเหตุที่ ${time}`,
    groupedNotesHeading: (count, time) => `${count} หมายเหตุใกล้เวลา ${time}`,
    closeGroup: "ปิดรายการช่วงเวลานี้",
    draftDeleteConfirm: (label) =>
      `ลบหมายเหตุ ${label} ถาวรหรือไม่? หมายเหตุในฉบับร่างไม่สามารถกู้คืนได้หลังลบ`,
    deletedAtLabel: (date) => `ลบเมื่อ ${date}`,
    showFullText: "ดูข้อความทั้งหมด",
    hideFullText: "ซ่อนข้อความทั้งหมด",
    beforeLabel: "ก่อนแก้ไข",
    afterLabel: "หลังแก้ไข",
    timeChanged: (before, after) => `เวลา ${before} → ${after}`,
  },
};

export function mediaUxCopy(language: Language): MediaCopy {
  return copyByLanguage[language];
}

export type MediaCapacity = {
  imageUsed: number;
  imageLimit: number;
  imageRemaining: number;
  videoUsed: number;
  videoLimit: number;
  videoRemaining: number;
};

export function computeMediaCapacity(items: ReadonlyArray<{ isVideo: boolean }>): MediaCapacity {
  let imageUsed = 0;
  let videoUsed = 0;
  for (const item of items) {
    if (item.isVideo) videoUsed += 1;
    else imageUsed += 1;
  }
  return {
    imageUsed,
    imageLimit: MEDIA_IMAGE_LIMIT,
    imageRemaining: Math.max(0, MEDIA_IMAGE_LIMIT - imageUsed),
    videoUsed,
    videoLimit: MEDIA_VIDEO_LIMIT,
    videoRemaining: Math.max(0, MEDIA_VIDEO_LIMIT - videoUsed),
  };
}

export type FileValidationCode =
  | "imageVideoOnly"
  | "sourceImageTooLarge"
  | "videoTooLarge"
  | "imageLimit"
  | "videoLimit";

export type FileBatchPartition = {
  accepted: File[];
  rejected: Array<{ file: File; code: FileValidationCode }>;
};

export function partitionMediaFiles(
  files: Iterable<File>,
  existing: ReadonlyArray<{ isVideo: boolean }>,
): FileBatchPartition {
  const accepted: File[] = [];
  const rejected: Array<{ file: File; code: FileValidationCode }> = [];
  let imageCount = existing.filter((item) => !item.isVideo).length;
  let videoCount = existing.filter((item) => item.isVideo).length;

  for (const file of files) {
    const isVideo = file.type.startsWith("video/");
    const isImage = file.type.startsWith("image/");
    if (!isVideo && !isImage) {
      rejected.push({ file, code: "imageVideoOnly" });
      continue;
    }
    if (isImage && file.size > IMAGE_SOURCE_BYTES) {
      rejected.push({ file, code: "sourceImageTooLarge" });
      continue;
    }
    if (isVideo && file.size > MEDIA_VIDEO_MAX_BYTES) {
      rejected.push({ file, code: "videoTooLarge" });
      continue;
    }
    if (isImage && imageCount >= MEDIA_IMAGE_LIMIT) {
      rejected.push({ file, code: "imageLimit" });
      continue;
    }
    if (isVideo && videoCount >= MEDIA_VIDEO_LIMIT) {
      rejected.push({ file, code: "videoLimit" });
      continue;
    }
    if (isImage) imageCount += 1;
    else videoCount += 1;
    accepted.push(file);
  }

  return { accepted, rejected };
}

export function validateCapturedPhoto(
  file: Pick<File, "size" | "type">,
  existing: ReadonlyArray<{ isVideo: boolean }>,
): FileValidationCode | null {
  if (!file.type.startsWith("image/")) return "imageVideoOnly";
  if (file.size > IMAGE_SOURCE_BYTES) return "sourceImageTooLarge";
  const imageCount = existing.filter((item) => !item.isVideo).length;
  if (imageCount >= MEDIA_IMAGE_LIMIT) return "imageLimit";
  return null;
}

export type TimeMarkCluster = {
  id: string;
  percent: number;
  time: number;
  marks: Annotation[];
};

/**
 * Group overlapping video timestamp markers so colocated markers stay reachable
 * on narrow 320 px viewports by touch and keyboard.
 */
export function groupTimeMarks(
  marks: ReadonlyArray<Annotation>,
  totalDuration: number,
  thresholdPercent = 11,
): TimeMarkCluster[] {
  const total = totalDuration > 0 ? totalDuration : Math.max(...marks.map((mark) => mark.time ?? 0), 1);
  const sorted = [...marks].sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.label - b.label);
  const clusters: TimeMarkCluster[] = [];

  for (const mark of sorted) {
    const time = mark.time ?? 0;
    const percent = Math.min(100, Math.max(0, (time / total) * 100));
    const current = clusters[clusters.length - 1];
    if (current && Math.abs(percent - current.percent) <= thresholdPercent) {
      current.marks.push(mark);
    } else {
      clusters.push({
        id: mark.id,
        percent,
        time,
        marks: [mark],
      });
    }
  }

  return clusters;
}

export type AnnotationChangeSummary = {
  positionChanged: boolean;
  timeChanged: boolean;
  previousTime?: number;
  nextTime?: number;
  textChanged: boolean;
  textTruncated: boolean;
};

export function summarizeAnnotationUpdate(
  action: string,
  before?: { x?: number; y?: number; time?: number; text?: string },
  after?: { x?: number; y?: number; time?: number; text?: string },
  previewLimit = 80,
): AnnotationChangeSummary {
  if (action !== "updated" || !before || !after) {
    return {
      positionChanged: false,
      timeChanged: false,
      textChanged: false,
      textTruncated: false,
    };
  }
  const positionChanged = before.x !== after.x || before.y !== after.y;
  const timeChanged =
    before.time !== undefined && after.time !== undefined && before.time !== after.time;
  const textChanged = before.text !== after.text;
  const textTruncated =
    textChanged &&
    ((before.text?.length ?? 0) > previewLimit || (after.text?.length ?? 0) > previewLimit);

  return {
    positionChanged,
    timeChanged,
    previousTime: timeChanged ? before.time : undefined,
    nextTime: timeChanged ? after.time : undefined,
    textChanged,
    textTruncated,
  };
}

export const INTERACTIVE_MEDIA_SELECTOR =
  'input, textarea, select, video, audio, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="listbox"], [data-pin-surface]';

export function carouselArrowDirection(
  key: string,
  orientation: "horizontal" | "vertical",
): "prev" | "next" | null {
  if (orientation === "vertical") {
    if (key === "ArrowUp") return "prev";
    if (key === "ArrowDown") return "next";
    return null;
  }
  if (key === "ArrowLeft") return "prev";
  if (key === "ArrowRight") return "next";
  return null;
}

export function shouldCarouselHandleKey(options: {
  keyboardNavigation: boolean;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isCarouselRoot: boolean;
  isCarouselNav: boolean;
  inInteractiveControl: boolean;
}): boolean {
  if (!options.keyboardNavigation || options.defaultPrevented) return false;
  if (options.altKey || options.ctrlKey || options.metaKey) return false;
  if (options.inInteractiveControl) return false;
  return options.isCarouselRoot || options.isCarouselNav;
}

export type DragCueState = {
  depth: number;
  active: boolean;
};

export type DragCueEvent =
  | { type: "enter" }
  | { type: "over" }
  | { type: "leave"; targetPosition: "inside" | "outside" | "unknown" }
  | { type: "reset" };

/**
 * Keep dragenter/dragleave nesting depth synchronized across nested children,
 * external exits, and browsers or synthetic events that emit relatedTarget=null.
 */
export function stepDragCueState(state: DragCueState, event: DragCueEvent): DragCueState {
  switch (event.type) {
    case "enter":
      return { depth: state.depth + 1, active: true };
    case "over":
      return { depth: Math.max(1, state.depth), active: true };
    case "leave": {
      const nextDepth = Math.max(0, state.depth - 1);
      if (event.targetPosition === "inside") {
        return { depth: nextDepth, active: state.active };
      }
      if (event.targetPosition === "outside") {
        return { depth: 0, active: false };
      }
      return { depth: nextDepth, active: nextDepth > 0 };
    }
    case "reset":
      return { depth: 0, active: false };
  }
}

/**
 * Anchor pin overlays flush with media edges at corners (0% / 100%) and centered
 * in the interior (50%) so pins and scale rings never clip at 320 px or 200% zoom.
 */
export function pinAnchorPercent(coord: number): number {
  const clamped = Math.min(1, Math.max(0, coord));
  return Math.round(clamped * 1000) / 10;
}
