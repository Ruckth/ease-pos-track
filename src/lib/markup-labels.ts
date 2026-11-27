import type { Language } from "@/lib/i18n";
import { IMAGE_MARKUP_ERRORS, MARKUP_MAX_EDGE, MARKUP_MAX_PIXELS, type imageMarkupErrorCode } from "@/lib/image-markup";

export type ImageMarkupErrorCode = ReturnType<typeof imageMarkupErrorCode>;

const MAX_PIXELS = MARKUP_MAX_PIXELS.toLocaleString("en-US");
const MAX_EDGE = MARKUP_MAX_EDGE.toLocaleString("en-US");

/** EN/TH copy for the draft screenshot editor. Kept apart from the main dictionary. */
export type MarkupLabels = {
  title: string; loading: string; loadFailed: string;
  /** Concrete reason for a decode failure code; the generic message otherwise. */
  loadError: (code: ImageMarkupErrorCode) => string;
  /** Concrete reason for an export failure code; the generic message otherwise. */
  exportError: (code: ImageMarkupErrorCode) => string;
  tools: string; select: string; pan: string; hintPan: string;
  view: string; zoomIn: string; zoomOut: string; zoomLevel: string; fitImage: string; fitWidth: string; previewRegion: string;
  fineSteps: string; position: string; left: string; top: string; circle: string; crop: string; mask: string; eraser: string;
  hintSelect: string; hintCircle: string; hintCrop: string; hintMask: string; hintErase: string; hintSecondCorner: string;
  canvasLabel: string; keyboardHint: string;
  marks: string; chooseMark: string; markName: (kind: "circle" | "mask" | "crop", n: number) => string;
  resize: string; width: string; height: string; narrower: string; wider: string; shorter: string; taller: string;
  move: string; moveLeft: string; moveRight: string; moveUp: string; moveDown: string;
  outline: string; thin: string; medium: string; thick: string;
  removeSelected: string; resetCrop: string; undo: string; redo: string; cancel: string;
  review: string; reviewing: string; reviewTitle: string; reviewHint: string; backToEdit: string; apply: string; applying: string;
  outputMeta: (w: number, h: number, size: string, type: string) => string;
  exportFailed: string; applyFailed: string;
  pinsOutside: (labels: string) => string; expandCrop: string;
  selected: (name: string) => string; adjusted: (name: string) => string; erased: (name: string) => string;
  cropReset: string; undone: string; redone: string; areaTooSmall: string; finishSelection: string;
  pin: (n: number) => string;
};

const en: MarkupLabels = {
  title: "Edit image", loading: "Opening image…", loadFailed: "This image can't be edited. The attachment is unchanged.",
  loadError: (code) => ({
    [IMAGE_MARKUP_ERRORS.tooLarge]: "This image is over 20 MB, so it can't be edited. The attachment is unchanged.",
    [IMAGE_MARKUP_ERRORS.dimensionsTooLarge]: `This image is too large to edit: the limit is ${MAX_PIXELS} pixels in total and ${MAX_EDGE} px per side. The attachment is unchanged.`,
    [IMAGE_MARKUP_ERRORS.format]: "Only still PNG and JPEG images can be edited. The attachment is unchanged.",
    [IMAGE_MARKUP_ERRORS.animation]: "Animated images can't be edited. Only still PNG and JPEG images can. The attachment is unchanged.",
  } as Partial<Record<ImageMarkupErrorCode, string>>)[code] ?? en.loadFailed,
  exportError: (code) => code === IMAGE_MARKUP_ERRORS.tooLarge
    ? "The edited image is over 8 MB. Crop to a smaller area, then review again. Your edits are still here."
    : en.exportFailed,
  tools: "Editing tools", select: "Select", pan: "Pan", circle: "Circle", crop: "Crop", mask: "Hide details", eraser: "Eraser",
  hintPan: "Drag to move the view. With any tool, drag with two fingers to move the view.",
  view: "View", zoomIn: "Zoom in", zoomOut: "Zoom out", zoomLevel: "Zoom level", fitImage: "Fit image", fitWidth: "Fit width",
  previewRegion: "Attachment preview. Swipe, scroll or use the arrow keys to move around.",
  fineSteps: "1 px steps", position: "Position", left: "Left", top: "Top",
  hintSelect: "Tap a mark to select it. Drag a handle to resize it, or use the controls below.",
  hintCircle: "Tap the area you want to point out to draw an oval.",
  hintCrop: "Drag across the area to keep, or tap two opposite corners.",
  hintMask: "Drag across private details, or tap two opposite corners. The covered pixels are removed from the attachment.",
  hintErase: "Tap a circle or mask to erase it. For overlapping marks, choose one from the list.",
  hintSecondCorner: "Now choose the opposite corner.",
  canvasLabel: "Image editing area",
  keyboardHint: "Use the arrow keys to move the cursor or the selected mark. Hold Shift for larger steps or Alt for single pixels. Press + or - to zoom and 0 to fit. Press Enter to place, Delete to remove, Escape to cancel.",
  marks: "Marks", chooseMark: "Choose a mark",
  markName: (kind, n) => kind === "crop" ? "Crop frame" : `${kind === "circle" ? "Circle" : "Mask"} ${n}`,
  resize: "Resize", width: "Width", height: "Height", narrower: "Narrower", wider: "Wider", shorter: "Shorter", taller: "Taller",
  move: "Move", moveLeft: "Move left", moveRight: "Move right", moveUp: "Move up", moveDown: "Move down",
  outline: "Outline", thin: "Thin", medium: "Medium", thick: "Thick",
  removeSelected: "Remove selected mark", resetCrop: "Reset crop", undo: "Undo", redo: "Redo", cancel: "Cancel",
  review: "Review", reviewing: "Preparing…", reviewTitle: "Review the attachment",
  reviewHint: "This is the exact image that will replace the attachment. Hidden details can't be recovered after you apply.",
  backToEdit: "Back to editing", apply: "Apply", applying: "Applying…",
  outputMeta: (w, h, size, type) => `${w} × ${h} px · ${size} · ${type}`,
  exportFailed: "The image couldn't be prepared. Your edits are still here.",
  applyFailed: "The attachment changed, so these edits weren't applied. Review again.",
  pinsOutside: (labels) => `The crop leaves out note ${labels}. Expand the crop to keep the note on the image.`,
  expandCrop: "Expand crop to include notes",
  selected: (name) => `${name} selected.`, adjusted: (name) => `${name} adjusted.`, erased: (name) => `${name} erased. Undo restores it.`,
  cropReset: "Full frame restored.", undone: "Edit undone.", redone: "Edit restored.",
  areaTooSmall: "Choose a wider or taller area.", finishSelection: "Finish the selection or press Escape to cancel it.",
  pin: (n) => `Note ${n}`,
};

const th: MarkupLabels = {
  title: "แก้ไขรูปภาพ", loading: "กำลังเปิดรูปภาพ…", loadFailed: "แก้ไขรูปภาพนี้ไม่ได้ ไฟล์แนบยังเหมือนเดิม",
  loadError: (code) => ({
    [IMAGE_MARKUP_ERRORS.tooLarge]: "รูปภาพนี้ใหญ่เกิน 20 MB จึงแก้ไขไม่ได้ ไฟล์แนบยังเหมือนเดิม",
    [IMAGE_MARKUP_ERRORS.dimensionsTooLarge]: `รูปภาพนี้ใหญ่เกินกว่าจะแก้ไขได้ ขีดจำกัดคือรวม ${MAX_PIXELS} พิกเซล และไม่เกิน ${MAX_EDGE} พิกเซลต่อด้าน ไฟล์แนบยังเหมือนเดิม`,
    [IMAGE_MARKUP_ERRORS.format]: "แก้ไขได้เฉพาะรูปภาพนิ่ง PNG และ JPEG ไฟล์แนบยังเหมือนเดิม",
    [IMAGE_MARKUP_ERRORS.animation]: "แก้ไขภาพเคลื่อนไหวไม่ได้ แก้ไขได้เฉพาะรูปภาพนิ่ง PNG และ JPEG ไฟล์แนบยังเหมือนเดิม",
  } as Partial<Record<ImageMarkupErrorCode, string>>)[code] ?? th.loadFailed,
  exportError: (code) => code === IMAGE_MARKUP_ERRORS.tooLarge
    ? "รูปภาพที่แก้ไขแล้วใหญ่เกิน 8 MB ครอบตัดให้เล็กลงแล้วตรวจทานอีกครั้ง การแก้ไขของคุณยังอยู่"
    : th.exportFailed,
  tools: "เครื่องมือแก้ไข", select: "เลือก", pan: "เลื่อนมุมมอง", circle: "วงกลม", crop: "ครอบตัด", mask: "ปิดบังข้อมูล", eraser: "ยางลบ",
  hintPan: "ลากเพื่อเลื่อนมุมมอง ใช้สองนิ้วลากเพื่อเลื่อนมุมมองได้กับทุกเครื่องมือ",
  view: "มุมมอง", zoomIn: "ซูมเข้า", zoomOut: "ซูมออก", zoomLevel: "ระดับการซูม", fitImage: "พอดีกรอบ", fitWidth: "พอดีความกว้าง",
  previewRegion: "ตัวอย่างไฟล์แนบ ปัด เลื่อน หรือใช้ปุ่มลูกศรเพื่อดูส่วนอื่นของรูป",
  fineSteps: "ทีละ 1 พิกเซล", position: "ตำแหน่ง", left: "ซ้าย", top: "บน",
  hintSelect: "แตะเครื่องหมายเพื่อเลือก ลากจุดจับเพื่อปรับขนาด หรือใช้ปุ่มด้านล่าง",
  hintCircle: "แตะจุดที่ต้องการชี้เพื่อวาดวงรี",
  hintCrop: "ลากคลุมส่วนที่ต้องการเก็บไว้ หรือแตะมุมตรงข้ามสองมุม",
  hintMask: "ลากคลุมข้อมูลส่วนตัว หรือแตะมุมตรงข้ามสองมุม พิกเซลที่ถูกปิดจะถูกลบออกจากไฟล์แนบ",
  hintErase: "แตะวงกลมหรือแถบปิดบังเพื่อลบ หากเครื่องหมายซ้อนกัน ให้เลือกจากรายการ",
  hintSecondCorner: "เลือกมุมตรงข้าม",
  canvasLabel: "พื้นที่แก้ไขรูปภาพ",
  keyboardHint: "ใช้ปุ่มลูกศรเพื่อเลื่อนเคอร์เซอร์หรือเครื่องหมายที่เลือก กด Shift ค้างไว้เพื่อเลื่อนทีละมาก หรือ Alt เพื่อเลื่อนทีละพิกเซล กด + หรือ - เพื่อซูม และ 0 เพื่อพอดีกรอบ กด Enter เพื่อวาง Delete เพื่อลบ Escape เพื่อยกเลิก",
  marks: "เครื่องหมาย", chooseMark: "เลือกเครื่องหมาย",
  markName: (kind, n) => kind === "crop" ? "กรอบครอบตัด" : `${kind === "circle" ? "วงกลม" : "แถบปิดบัง"} ${n}`,
  resize: "ปรับขนาด", width: "ความกว้าง", height: "ความสูง", narrower: "แคบลง", wider: "กว้างขึ้น", shorter: "เตี้ยลง", taller: "สูงขึ้น",
  move: "ย้าย", moveLeft: "ย้ายไปซ้าย", moveRight: "ย้ายไปขวา", moveUp: "ย้ายขึ้น", moveDown: "ย้ายลง",
  outline: "เส้นขอบ", thin: "บาง", medium: "กลาง", thick: "หนา",
  removeSelected: "ลบเครื่องหมายที่เลือก", resetCrop: "รีเซ็ตการครอบตัด", undo: "เลิกทำ", redo: "ทำซ้ำ", cancel: "ยกเลิก",
  review: "ตรวจทาน", reviewing: "กำลังเตรียม…", reviewTitle: "ตรวจทานไฟล์แนบ",
  reviewHint: "นี่คือรูปภาพที่จะใช้แทนไฟล์แนบเดิม ข้อมูลที่ปิดบังจะกู้คืนไม่ได้หลังจากใช้การแก้ไข",
  backToEdit: "กลับไปแก้ไข", apply: "ใช้การแก้ไข", applying: "กำลังใช้การแก้ไข…",
  outputMeta: (w, h, size, type) => `${w} × ${h} พิกเซล · ${size} · ${type}`,
  exportFailed: "เตรียมรูปภาพไม่สำเร็จ การแก้ไขของคุณยังอยู่",
  applyFailed: "ไฟล์แนบมีการเปลี่ยนแปลง จึงยังไม่ได้ใช้การแก้ไขนี้ โปรดตรวจทานอีกครั้ง",
  pinsOutside: (labels) => `การครอบตัดทำให้โน้ต ${labels} หลุดออกจากรูป ขยายกรอบเพื่อเก็บโน้ตไว้บนรูป`,
  expandCrop: "ขยายกรอบให้ครอบคลุมโน้ต",
  selected: (name) => `เลือก${name}แล้ว`, adjusted: (name) => `ปรับ${name}แล้ว`, erased: (name) => `ลบ${name}แล้ว กดเลิกทำเพื่อกู้คืน`,
  cropReset: "คืนค่าเต็มกรอบแล้ว", undone: "เลิกทำแล้ว", redone: "ทำซ้ำแล้ว",
  areaTooSmall: "เลือกพื้นที่ให้กว้างหรือสูงกว่านี้", finishSelection: "เลือกมุมที่สองให้เสร็จ หรือกด Escape เพื่อยกเลิก",
  pin: (n) => `โน้ต ${n}`,
};

export function markupLabels(language: Language): MarkupLabels {
  return language === "th" ? th : en;
}
