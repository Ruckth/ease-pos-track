import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Language = "th" | "en";
const STORAGE_KEY = "ease-pos-tracking-language";

const en = {
  languageThai: "ไทย", languageEnglish: "EN", appName: "Ease POS Tracking", internalBoard: "Internal feedback board",
  password: "Password", enter: "Enter", signingIn: "Signing in…", search: "Search", newFeedback: "New feedback",
  resumeFeedback: "Resume feedback", archive: "Archive", hideArchive: "Hide archive", signOut: "Sign out",
  feedbackItems: "{{count}} feedback items", syncing: "Syncing", archivedFeedback: "Archived feedback", restore: "Restore",
  new: "New", inProgress: "In progress", waiting: "Waiting", done: "Done", empty: "Empty", noMedia: "No media",
  topic: "Topic", description: "Description (optional)", noDescription: "No description provided.", media: "Media", submit: "Submit", submitting: "Submitting…", cancel: "Cancel",
  camera: "Camera", upload: "Upload", copy: "Copy", ticketNumber: "Ticket number", ticketCopied: "Ticket number copied",
  ticketCopyFailed: "Unable to copy ticket number.", created: "Created {{date}}", edit: "Edit", save: "Save", delete: "Delete",
  commentsOnMedia: "Comments on media", commentActivity: "Comment activity ({{count}})", feedbackActivity: "Feedback activity ({{count}})",
  recentlyDeleted: "Recently deleted", addPin: "Add pin", savePin: "Save pin", cancelMove: "Cancel move", removeMedia: "Remove media",
  removeMediaPins: "Remove media and pins?", feedbackSubmitted: "Feedback submitted.", statusUpdated: "Status updated", undo: "Undo",
  feedbackRestored: "Feedback restored", feedbackArchived: "Feedback archived for 30 days", genericError: "Something went wrong. Please try again.",
  sessionExpired: "Your session expired. Please sign in again.", incorrectPassword: "Incorrect password", rateLimited: "Too many attempts. Try again shortly.",
  requiredFeedback: "Topic and at least one photo or video are required.", imageVideoOnly: "Only images and videos are supported.",
  imageTooLarge: "Images must be 8MB or smaller.", videoTooLarge: "Videos must be 64MB or smaller.", actionCreated: "created", actionUpdated: "updated", actionDeleted: "deleted", actionRestored: "restored", actionUpdateUndone: "undid an update", actionEdited: "edited", actionEditUndone: "undid an edit", actionStatusChanged: "changed status", actionStatusUndone: "undid a status change",
  archivedOn: "Archived {{date}}", feedback: "Feedback", feedbackUpdated: "Feedback updated", commentUpdated: "Comment updated", commentRestored: "Comment restored", commentDeleted: "Comment deleted", pinAdded: "Pin added to draft", annotateMedia: "Annotate media", annotateDescription: "Add a pin, then describe the issue at that point.", pinSummary: "{{count}} pins ready to submit. Select media to review or add more.", pinHint: "Select a photo or video to add pins and descriptions before submitting.", cancelUpload: "Cancel upload", mediaUnavailable: "This media item is no longer available.", uploadCleanupFailed: "Unable to clean up uploaded files.", submitFailed: "Unable to submit feedback.", removeMediaDescription: "{{name}} has {{count}} pin descriptions. Removing it will discard those pins.", archiveConfirm: "Archive this feedback? It can be restored for 30 days.", mediaLinkHint: "Use [1], [2], and similar labels to link to media comments.", movedTo: "Move {{ticket}} to {{status}}", ticketComplete: "{{ticket}} is complete", ticketCompleteTitle: "Ticket is complete", createdAt: "Created {{date}}", language: "Language", cover: "Cover", addMedia: "Add more media", dropMedia: "Drop, paste, or tap to add photos and videos", mediaOrderHint: "First image becomes the cover. Drag tiles to reorder.", fileCount: "{{count}} files — drag tiles to reorder; the first image is the cover.", openMedia: "Open {{name}} to add pins", removeFile: "Remove {{name}}", imageLimit: "Up to 10 images are allowed.", videoLimit: "Up to 3 videos are allowed.", showComment: "Show comment {{label}} on media", editComment: "Edit comment {{label}}", deleteComment: "Delete comment {{label}}", deleteCommentConfirm: "Delete comment {{label}}? You can undo this afterwards.", videoAt: "video at {{time}}", imageNumber: "image {{number}}", unableUpdateComment: "Unable to update the comment.", unableDeleteComment: "Unable to delete the comment.", unableRestoreComment: "Unable to restore the comment.", comment: "Comment {{label}}", positionChanged: "position changed", mediaNumber: "Show media {{number}}", describeIssue: "Describe the issue at this spot", markPoint: "Mark a point on this frame", placePin: "Select media to place a pin", moveComment: "Select media to move this comment.", unableMoveComment: "Unable to move the comment.", unableSaveComment: "Unable to save the comment.", previousSlide: "Previous slide", nextSlide: "Next slide", closeDialog: "Close dialog", reload: "Reload", appError: "Something went wrong", appErrorDescription: "Reload the app to recover the workspace before trying again.",
} as const;

const th: Record<keyof typeof en, string> = {
  languageThai: "ไทย", languageEnglish: "EN", appName: "ติดตาม Ease POS", internalBoard: "กระดานแจ้งปัญหาภายใน",
  password: "รหัสผ่าน", enter: "เข้าสู่ระบบ", signingIn: "กำลังเข้าสู่ระบบ…", search: "ค้นหา", newFeedback: "แจ้งปัญหา",
  resumeFeedback: "ทำต่อ", archive: "คลังข้อมูล", hideArchive: "ซ่อนคลัง", signOut: "ออกจากระบบ",
  feedbackItems: "รายการแจ้งปัญหา {{count}} รายการ", syncing: "กำลังซิงก์", archivedFeedback: "รายการในคลัง", restore: "กู้คืน",
  new: "ใหม่", inProgress: "กำลังทำ", waiting: "รอ", done: "เสร็จ", empty: "ไม่มีรายการ", noMedia: "ไม่มีไฟล์",
  topic: "หัวข้อ", description: "รายละเอียด (ไม่บังคับ)", noDescription: "ไม่มีรายละเอียด", media: "รูปหรือวิดีโอ", submit: "ส่งเรื่อง", submitting: "กำลังส่ง…", cancel: "ยกเลิก",
  camera: "กล้อง", upload: "อัปโหลด", copy: "คัดลอก", ticketNumber: "เลขที่แจ้ง", ticketCopied: "คัดลอกเลขที่แจ้งแล้ว",
  ticketCopyFailed: "คัดลอกเลขที่แจ้งไม่สำเร็จ", created: "สร้างเมื่อ {{date}}", edit: "แก้ไข", save: "บันทึก", delete: "ลบ",
  commentsOnMedia: "ความเห็นบนรูปหรือวิดีโอ", commentActivity: "ประวัติความเห็น ({{count}})", feedbackActivity: "ประวัติรายการ ({{count}})",
  recentlyDeleted: "ที่เพิ่งลบ", addPin: "เพิ่มจุด", savePin: "บันทึกจุด", cancelMove: "ยกเลิกการย้าย", removeMedia: "ลบไฟล์",
  removeMediaPins: "ลบไฟล์และจุดทั้งหมด?", feedbackSubmitted: "ส่งเรื่องแล้ว", statusUpdated: "อัปเดตสถานะแล้ว", undo: "เลิกทำ",
  feedbackRestored: "กู้คืนรายการแล้ว", feedbackArchived: "ย้ายเข้าคลัง 30 วันแล้ว", genericError: "เกิดข้อผิดพลาด โปรดลองอีกครั้ง",
  sessionExpired: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", incorrectPassword: "รหัสผ่านไม่ถูกต้อง", rateLimited: "ลองใหม่อีกครั้งในภายหลัง",
  requiredFeedback: "กรอกหัวข้อและเพิ่มรูปหรือวิดีโออย่างน้อย 1 ไฟล์", imageVideoOnly: "รองรับเฉพาะรูปและวิดีโอ",
  imageTooLarge: "รูปต้องมีขนาดไม่เกิน 8MB", videoTooLarge: "วิดีโอต้องมีขนาดไม่เกิน 64MB", actionCreated: "สร้างแล้ว", actionUpdated: "อัปเดตแล้ว", actionDeleted: "ลบแล้ว", actionRestored: "กู้คืนแล้ว", actionUpdateUndone: "เลิกทำการอัปเดต", actionEdited: "แก้ไขแล้ว", actionEditUndone: "เลิกทำการแก้ไข", actionStatusChanged: "เปลี่ยนสถานะ", actionStatusUndone: "เลิกทำการเปลี่ยนสถานะ",
  archivedOn: "เก็บเข้าคลังเมื่อ {{date}}", feedback: "รายการแจ้งปัญหา", feedbackUpdated: "อัปเดตรายการแล้ว", commentUpdated: "อัปเดตความเห็นแล้ว", commentRestored: "กู้คืนความเห็นแล้ว", commentDeleted: "ลบความเห็นแล้ว", pinAdded: "เพิ่มจุดในฉบับร่างแล้ว", annotateMedia: "ใส่จุดบนรูปหรือวิดีโอ", annotateDescription: "เพิ่มจุด แล้วอธิบายปัญหาตรงนั้น", pinSummary: "มี {{count}} จุดพร้อมส่ง เลือกไฟล์เพื่อตรวจสอบหรือเพิ่มจุด", pinHint: "เลือกรูปหรือวิดีโอเพื่อเพิ่มจุดและรายละเอียดก่อนส่ง", cancelUpload: "ยกเลิกอัปโหลด", mediaUnavailable: "ไม่พบไฟล์นี้แล้ว", uploadCleanupFailed: "ล้างไฟล์ที่อัปโหลดไม่สำเร็จ", submitFailed: "ส่งเรื่องไม่สำเร็จ", removeMediaDescription: "{{name}} มีคำอธิบาย {{count}} จุด การลบไฟล์จะลบจุดเหล่านี้ด้วย", archiveConfirm: "เก็บรายการนี้เข้าคลัง? สามารถกู้คืนได้ภายใน 30 วัน", mediaLinkHint: "ใช้ [1], [2] และตัวเลขอื่นเพื่อเชื่อมกับความเห็นบนไฟล์", movedTo: "ย้าย {{ticket}} ไป {{status}}", ticketComplete: "{{ticket}} เสร็จแล้ว", ticketCompleteTitle: "รายการเสร็จแล้ว", createdAt: "สร้างเมื่อ {{date}}", language: "ภาษา", cover: "ภาพปก", addMedia: "เพิ่มรูปหรือวิดีโอ", dropMedia: "วาง วางจากคลิปบอร์ด หรือแตะเพื่อเพิ่มรูปและวิดีโอ", mediaOrderHint: "รูปแรกจะเป็นภาพปก ลากเพื่อเรียงลำดับ", fileCount: "{{count}} ไฟล์ — ลากเพื่อเรียงลำดับ รูปแรกเป็นภาพปก", openMedia: "เปิด {{name}} เพื่อเพิ่มจุด", removeFile: "ลบ {{name}}", imageLimit: "เพิ่มรูปได้สูงสุด 10 รูป", videoLimit: "เพิ่มวิดีโอได้สูงสุด 3 ไฟล์", showComment: "แสดงความเห็น {{label}} บนไฟล์", editComment: "แก้ไขความเห็น {{label}}", deleteComment: "ลบความเห็น {{label}}", deleteCommentConfirm: "ลบความเห็น {{label}}? สามารถเลิกทำภายหลังได้", videoAt: "วิดีโอที่ {{time}}", imageNumber: "รูป {{number}}", unableUpdateComment: "อัปเดตความเห็นไม่สำเร็จ", unableDeleteComment: "ลบความเห็นไม่สำเร็จ", unableRestoreComment: "กู้คืนความเห็นไม่สำเร็จ", comment: "ความเห็น {{label}}", positionChanged: "เปลี่ยนตำแหน่งแล้ว", mediaNumber: "แสดงไฟล์ {{number}}", describeIssue: "อธิบายปัญหาตรงนี้", markPoint: "ทำเครื่องหมายบนเฟรมนี้", placePin: "เลือกจุดบนไฟล์เพื่อวางหมุด", moveComment: "เลือกจุดบนไฟล์เพื่อย้ายความเห็นนี้", unableMoveComment: "ย้ายความเห็นไม่สำเร็จ", unableSaveComment: "บันทึกความเห็นไม่สำเร็จ", previousSlide: "ไฟล์ก่อนหน้า", nextSlide: "ไฟล์ถัดไป", closeDialog: "ปิดหน้าต่าง", reload: "โหลดใหม่", appError: "เกิดข้อผิดพลาด", appErrorDescription: "โหลดแอปใหม่เพื่อกลับไปทำงานต่อ",
};

type Key = keyof typeof en;
type I18n = { language: Language; setLanguage: (language: Language) => void; t: (key: Key, values?: Record<string, string | number>) => string; formatDate: (timestamp: number) => string };
const I18nContext = createContext<I18n | null>(null);

export function resolveLanguage(stored: string | null): Language {
  return stored === "en" ? "en" : "th";
}

export function translate(language: Language, key: Key, values: Record<string, string | number> = {}) {
  return (language === "th" ? th : en)[key].replace(/{{(\w+)}}/g, (_, name) => String(values[name] ?? ""));
}

export function formatLocalizedDate(language: Language, timestamp: number) {
  return new Intl.DateTimeFormat(language === "th" ? "th-TH-u-ca-buddhist" : "en-US", { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function savedLanguage(): Language {
  return resolveLanguage(window.localStorage.getItem(STORAGE_KEY));
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<Language>(savedLanguage);
  const value = useMemo<I18n>(() => ({
    language,
    setLanguage(next) { window.localStorage.setItem(STORAGE_KEY, next); setLanguageState(next); },
    t(key, values = {}) { return translate(language, key, values); },
    formatDate(timestamp) { return formatLocalizedDate(language, timestamp); },
  }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() { const value = useContext(I18nContext); if (!value) throw new Error("I18N_CONTEXT_MISSING"); return value; }
export function localizeError(error: unknown, t: I18n["t"]) {
  const code = error instanceof Error ? error.message : "";
  const keys: Record<string, Key> = { SESSION_EXPIRED: "sessionExpired", INCORRECT_PASSWORD: "incorrectPassword", AUTH_RATE_LIMITED: "rateLimited", REQUIRED_FEEDBACK: "requiredFeedback", IMAGE_VIDEO_ONLY: "imageVideoOnly", IMAGE_TOO_LARGE: "imageTooLarge", VIDEO_TOO_LARGE: "videoTooLarge" };
  return keys[code] ? t(keys[code]) : t("genericError");
}
