import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type Language = "th" | "en";
const STORAGE_KEY = "ease-pos-tracking-language";

const en = {
  languageThai: "ไทย", languageEnglish: "EN", appName: "Ease POS Tracking", internalBoard: "Internal Ticket board",
  password: "Password", enter: "Enter", signingIn: "Signing in…", search: "Search", newFeedback: "New Ticket",
  resumeFeedback: "Continue Ticket", archive: "Archive", hideArchive: "Hide archive", signOut: "Sign out",
  feedbackItems: "{{count}} Tickets", syncing: "Syncing", archivedFeedback: "Archived Tickets", restore: "Restore",
  new: "New", acknowledged: "Acknowledged", inProgress: "In progress", waiting: "Waiting for customer", done: "Resolved", empty: "Empty", noMedia: "No media",
  topic: "Topic", description: "Description (optional)", noDescription: "No description provided.", media: "Media (optional)", submit: "Submit", submitting: "Submitting…", cancel: "Cancel",
  camera: "Camera", cameraDescription: "Take a photo without leaving this ticket.", cameraOpening: "Starting camera…", cameraPreview: "Live camera preview", takePhoto: "Take photo", usePhotoPicker: "Choose a photo instead", cameraPermissionDenied: "Camera access was blocked. Allow camera permission in your browser, then try again.", cameraUnavailable: "No usable camera was found on this device.", cameraStartFailed: "The camera could not start. Try again or upload a photo.", upload: "Upload", copy: "Copy", ticketNumber: "Ticket number", ticketCopied: "Ticket number copied",
  ticketCopyFailed: "Unable to copy ticket number.", created: "Created {{date}}", edit: "Edit", save: "Save", delete: "Delete",
  commentsOnMedia: "Notes on files", commentActivity: "Note activity ({{count}})", feedbackActivity: "Ticket activity ({{count}})",
  recentlyDeleted: "Recently deleted", addPin: "Add note", savePin: "Save note", cancelMove: "Cancel move", removeMedia: "Remove file",
  removeMediaPins: "Remove this file and its notes?", feedbackSubmitted: "Ticket submitted.", statusUpdated: "Status updated", undo: "Undo",
  feedbackRestored: "Ticket restored", feedbackArchived: "Ticket archived for 30 days", genericError: "Something went wrong. Please try again.",
  sessionExpired: "Your session expired. Please sign in again.", incorrectPassword: "Incorrect password", rateLimited: "Too many attempts. Try again shortly.",
  requiredFeedback: "A topic is required.", imageVideoOnly: "Only images and videos are supported.",
  imageTooLarge: "Images must be 8MB or smaller.", videoTooLarge: "Videos must be 64MB or smaller.", actionCreated: "created", actionMediaAttached: "attached images", actionUpdated: "updated", actionDeleted: "deleted", actionRestored: "restored", actionUpdateUndone: "undid an update", actionEdited: "edited", actionEditUndone: "undid an edit", actionStatusChanged: "changed status", actionStatusUndone: "undid a status change",
  archivedOn: "Archived {{date}}", feedback: "Ticket", feedbackUpdated: "Ticket updated", commentUpdated: "Comment updated", commentRestored: "Comment restored", commentDeleted: "Comment deleted", pinAdded: "Note added to your Ticket", annotateMedia: "Mark a photo or video", annotateDescription: "Tap the exact spot, then add a short note.", pinSummary: "{{count}} notes added. Tap any photo or video to review them.", pinHint: "Tap a photo or video to point out exactly where the problem appears.", cancelUpload: "Cancel upload", mediaUnavailable: "This file is no longer available.", uploadCleanupFailed: "Unable to clean up uploaded files.", submitFailed: "Unable to submit the Ticket.", removeMediaDescription: "{{name}} has {{count}} notes. Removing the file will also remove those notes.", archiveConfirm: "Archive this Ticket? It can be restored for 30 days.", mediaLinkHint: "Use [1], [2], and similar labels to link to comments on your files.", movedTo: "Move {{ticket}} to {{status}}", ticketComplete: "{{ticket}} is resolved", ticketCompleteTitle: "Ticket is resolved", createdAt: "Created {{date}}", language: "Language", cover: "First", addMedia: "Add more photos or videos", dropMedia: "Drag and drop here, paste, or choose files from your device.", mediaOrderHint: "You can add up to 10 photos and 3 videos.", fileCount: "{{count}} files added", chooseFiles: "Choose files", addPhotosTitle: "Add photos or videos", uploadLimits: "Up to 10 photos (8 MB each) and 3 videos (64 MB each)", filesReady: "{{count}} files ready", reorderHint: "Drag to reorder. The first file becomes the cover.", addMore: "Add more", openMedia: "Open {{name}} to add a note", removeFile: "Remove {{name}}", imageLimit: "You can add up to 10 photos.", videoLimit: "You can add up to 3 videos.", showComment: "Show comment {{label}} on media", editComment: "Edit comment {{label}}", deleteComment: "Delete comment {{label}}", deleteCommentConfirm: "Delete comment {{label}}? You can undo this afterwards.", videoAt: "video at {{time}}", imageNumber: "image {{number}}", unableUpdateComment: "Unable to update the comment.", unableDeleteComment: "Unable to delete the comment.", unableRestoreComment: "Unable to restore the comment.", comment: "Comment {{label}}", positionChanged: "position changed", mediaNumber: "Show media {{number}}", describeIssue: "Describe what is happening here", markPoint: "Mark the exact spot", placePin: "Tap the photo to place a marker", moveComment: "Tap a new spot to move this comment.", unableMoveComment: "Unable to move this comment.", unableSaveComment: "Unable to save this comment.", previousSlide: "Previous file", nextSlide: "Next file", closeDialog: "Close dialog", reload: "Reload", appError: "Something went wrong", appErrorDescription: "Reload the app to recover the workspace before trying again.",

  // Sign-in surfaces
  chooseAccountType: "How do you want to sign in?",
  chooseAccountTypeDescription: "Choose the space that matches what you need to do.",
  staffAccess: "Staff",
  staffAccessDescription: "Manage and update every Ticket.",
  customerAccess: "Customer",
  customerAccessDescription: "Create a Ticket and follow its progress.",
  staffSignIn: "Staff sign in",
  staffSignInDescription: "Enter the shared staff password to open the internal board.",
  customerSignIn: "Customer sign in",
  customerSignInDescription: "View your Tickets and create a new one.",
  customerSignUp: "Create a customer account",
  customerSignUpDescription: "Use your email and a password to follow your own tickets.",
  email: "Email",
  newPassword: "Password",
  confirmPassword: "Confirm password",
  passwordRules: "At least 10 characters, including a letter and a number.",
  signIn: "Sign in",
  createAccount: "Create account",
  creatingAccount: "Creating account…",
  haveAccountQuestion: "Already have an account?",
  noAccountQuestion: "No account yet?",
  useStaffPassword: "Sign in as staff instead",
  useCustomerAccount: "Sign in as a customer instead",

  // Customer portal
  customerPortal: "My tickets",
  customerPortalSubtitle: "Your support Tickets",
  customerSupport: "Customer support",
  customerPortalTitle: "How can we help today?",
  customerPortalIntro: "Create a ticket in a few steps, follow its progress, and see when the team needs more information from you.",
  signedInAs: "Signed in as {{email}}",
  newTicket: "New ticket",
  yourTickets: "Your tickets",
  ticketSummary: "Ticket summary",
  filterTickets: "Filter tickets",
  allTickets: "All",
  activeTickets: "Active",
  awaitingReply: "Needs your reply",
  awaitingReplyShort: "Reply",
  resolvedTickets: "Resolved",
  syncingTickets: "Getting your tickets ready…",
  noFilteredTickets: "No tickets match this view.",
  showAllTickets: "Show all tickets",
  openTicket: "View details",
  statusNextNew: "Received — the team will review it soon",
  statusNextAcknowledged: "The team has seen your ticket",
  statusNextInProgress: "The team is working on it",
  statusNextWaiting: "Your reply will help move this forward",
  statusNextDone: "This ticket has been resolved",
  myTicketsEmpty: "You do not have any Tickets yet.",
  myTicketsEmptyHint: "Create a Ticket to share details, photos, or videos with the team.",
  myTicketCount: "{{count}} total",
  viewTicket: "Open ticket {{ticket}}",
  editTicket: "Edit ticket",
  deleteTicket: "Delete ticket",
  deleteTicketConfirm: "Delete this ticket? The team keeps it archived for 30 days.",
  ticketDeleted: "Ticket deleted",
  ticketStatus: "Status",
  customerStatusHint: "The team updates this status as work moves forward.",
  updatedOn: "Updated {{date}}",

  // Three-step customer ticket flow
  stepDetails: "Details",
  stepMedia: "Photos & videos",
  stepReview: "Review and submit",
  stepNumber: "Step {{number}}",
  stepDetailsHint: "Start with a short topic. Add the details that will help the team understand what happened.",
  stepMediaHint: "Photos and videos are optional. Add them when they make the problem easier to understand.",
  stepReviewHint: "Make sure everything looks right. You can go back to change anything before submitting.",
  topicPlaceholder: "Example: Receipt printer is offline",
  descriptionPlaceholder: "What happened? When did it start? What have you already tried?",
  stepCompleted: "Completed",
  stepActive: "In progress",
  stepPending: "Pending",
  next: "Next",
  skipForNow: "Skip for now",
  back: "Back",
  reviewTopic: "Topic",
  reviewDescription: "Description",
  reviewMedia: "{{count}} files attached",
  reviewPins: "{{count}} image notes added",
  reviewNoPins: "No image notes added",
  submitTicket: "Submit ticket",
  requiredTitle: "A topic is required.",
  requiredMedia: "At least one photo or video is required.",
  titleTooLong: "Keep the topic under 100 characters.",
  descriptionTooLong: "The description is too long.",

  // Staff board
  dragTicket: "Drag ticket {{ticket}}",
  boardColumnCards: "{{count}} tickets in {{status}}",
  boardStatusTabs: "Show tickets by status",
  ticketProgress: "{{ticket}} progress: step {{step}} of {{total}}, {{percent}}% complete",
  ticketStep: "Step {{step}}/{{total}}",
  moveConflict: "Someone else updated this ticket. The board has been refreshed.",

  // Errors shared by both portals
  staffOnlyAction: "That action is limited to staff.",
  customerOnlyAction: "That action is only available to customer accounts.",
  ticketMissing: "That ticket is no longer available.",
  invalidEmail: "Enter a valid email address.",
  weakPassword: "Use at least 10 characters with a letter and a number.",
  passwordTooLongError: "Passwords must be 128 characters or fewer.",
  emailTaken: "That email already has an account.",
  invalidCredentials: "Email or password is incorrect.",
  passwordMismatch: "The two passwords do not match.",
  uploadIntentInvalid: "The upload session expired. Please try again.",
  uploadIncomplete: "The file upload did not finish. Please try again.",
  mediaLimitExceeded: "Up to 10 images and 3 videos are allowed.",
  accountsUnavailable: "Customer accounts are not available right now. Please contact the team.",
  commentMissing: "That comment is no longer available.",
  undoUnavailable: "This change can no longer be undone.",
  invalidFile: "That file could not be accepted. Please try another.",
} as const;

const th: Record<keyof typeof en, string> = {
  languageThai: "ไทย", languageEnglish: "EN", appName: "ติดตาม Ease POS", internalBoard: "กระดานแจ้งปัญหาภายใน",
  password: "รหัสผ่าน", enter: "เข้าสู่ระบบ", signingIn: "กำลังเข้าสู่ระบบ…", search: "ค้นหา", newFeedback: "แจ้งปัญหา",
  resumeFeedback: "ทำต่อ", archive: "คลังข้อมูล", hideArchive: "ซ่อนคลัง", signOut: "ออกจากระบบ",
  feedbackItems: "รายการแจ้งปัญหา {{count}} รายการ", syncing: "กำลังซิงก์", archivedFeedback: "รายการในคลัง", restore: "กู้คืน",
  new: "ใหม่", acknowledged: "รับเรื่องแล้ว", inProgress: "กำลังดำเนินการ", waiting: "รอข้อมูลลูกค้า", done: "แก้ไขแล้ว", empty: "ไม่มีรายการ", noMedia: "ไม่มีไฟล์",
  topic: "หัวข้อ", description: "รายละเอียด (ไม่บังคับ)", noDescription: "ไม่มีรายละเอียด", media: "รูปหรือวิดีโอ (ไม่บังคับ)", submit: "ส่งเรื่อง", submitting: "กำลังส่ง…", cancel: "ยกเลิก",
  camera: "กล้อง", cameraDescription: "ถ่ายรูปได้ทันทีโดยไม่ต้องออกจากรายการนี้", cameraOpening: "กำลังเปิดกล้อง…", cameraPreview: "ภาพตัวอย่างจากกล้อง", takePhoto: "ถ่ายรูป", usePhotoPicker: "เลือกรูปแทน", cameraPermissionDenied: "สิทธิ์ใช้งานกล้องถูกปิด โปรดอนุญาตกล้องในเบราว์เซอร์แล้วลองอีกครั้ง", cameraUnavailable: "ไม่พบกล้องที่ใช้งานได้บนอุปกรณ์นี้", cameraStartFailed: "เปิดกล้องไม่สำเร็จ โปรดลองอีกครั้งหรืออัปโหลดรูปแทน", upload: "อัปโหลด", copy: "คัดลอก", ticketNumber: "เลขที่แจ้ง", ticketCopied: "คัดลอกเลขที่แจ้งแล้ว",
  ticketCopyFailed: "คัดลอกเลขที่แจ้งไม่สำเร็จ", created: "สร้างเมื่อ {{date}}", edit: "แก้ไข", save: "บันทึก", delete: "ลบ",
  commentsOnMedia: "หมายเหตุบนไฟล์", commentActivity: "ประวัติหมายเหตุ ({{count}})", feedbackActivity: "ประวัติรายการ ({{count}})",
  recentlyDeleted: "ที่เพิ่งลบ", addPin: "เพิ่มหมายเหตุ", savePin: "บันทึกหมายเหตุ", cancelMove: "ยกเลิกการย้าย", removeMedia: "ลบไฟล์",
  removeMediaPins: "ลบไฟล์และจุดทั้งหมด?", feedbackSubmitted: "ส่งเรื่องแล้ว", statusUpdated: "อัปเดตสถานะแล้ว", undo: "เลิกทำ",
  feedbackRestored: "กู้คืนรายการแล้ว", feedbackArchived: "ย้ายเข้าคลัง 30 วันแล้ว", genericError: "เกิดข้อผิดพลาด โปรดลองอีกครั้ง",
  sessionExpired: "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่", incorrectPassword: "รหัสผ่านไม่ถูกต้อง", rateLimited: "ลองใหม่อีกครั้งในภายหลัง",
  requiredFeedback: "ต้องกรอกหัวข้อ", imageVideoOnly: "รองรับเฉพาะรูปและวิดีโอ",
  imageTooLarge: "รูปต้องมีขนาดไม่เกิน 8MB", videoTooLarge: "วิดีโอต้องมีขนาดไม่เกิน 64MB", actionCreated: "สร้างแล้ว", actionMediaAttached: "แนบรูปแล้ว", actionUpdated: "อัปเดตแล้ว", actionDeleted: "ลบแล้ว", actionRestored: "กู้คืนแล้ว", actionUpdateUndone: "เลิกทำการอัปเดต", actionEdited: "แก้ไขแล้ว", actionEditUndone: "เลิกทำการแก้ไข", actionStatusChanged: "เปลี่ยนสถานะ", actionStatusUndone: "เลิกทำการเปลี่ยนสถานะ",
  archivedOn: "เก็บเข้าคลังเมื่อ {{date}}", feedback: "เรื่อง", feedbackUpdated: "อัปเดตเรื่องแล้ว", commentUpdated: "อัปเดตความเห็นแล้ว", commentRestored: "กู้คืนความเห็นแล้ว", commentDeleted: "ลบความเห็นแล้ว", pinAdded: "เพิ่มหมายเหตุในเรื่องแล้ว", annotateMedia: "ทำเครื่องหมายบนรูปหรือวิดีโอ", annotateDescription: "แตะตำแหน่งที่มีปัญหา แล้วเพิ่มหมายเหตุสั้นๆ", pinSummary: "เพิ่มหมายเหตุแล้ว {{count}} จุด แตะรูปหรือวิดีโอเพื่อตรวจสอบ", pinHint: "แตะรูปหรือวิดีโอเพื่อชี้ตำแหน่งที่มีปัญหาให้ชัดเจน", cancelUpload: "ยกเลิกอัปโหลด", mediaUnavailable: "ไม่พบไฟล์นี้แล้ว", uploadCleanupFailed: "ล้างไฟล์ที่อัปโหลดไม่สำเร็จ", submitFailed: "ส่งเรื่องไม่สำเร็จ", removeMediaDescription: "{{name}} มีหมายเหตุ {{count}} จุด การลบไฟล์จะลบหมายเหตุเหล่านั้นด้วย", archiveConfirm: "เก็บเรื่องนี้เข้าคลัง? สามารถกู้คืนได้ภายใน 30 วัน", mediaLinkHint: "ใช้ [1], [2] และตัวเลขอื่นเพื่อเชื่อมกับความเห็นบนไฟล์", movedTo: "ย้าย {{ticket}} ไป {{status}}", ticketComplete: "{{ticket}} แก้ไขแล้ว", ticketCompleteTitle: "เรื่องได้รับการแก้ไขแล้ว", createdAt: "สร้างเมื่อ {{date}}", language: "ภาษา", cover: "ไฟล์แรก", addMedia: "เพิ่มรูปหรือวิดีโอ", dropMedia: "ลากไฟล์มาวาง วางจากคลิปบอร์ด หรือเลือกไฟล์จากอุปกรณ์", mediaOrderHint: "เพิ่มรูปได้สูงสุด 10 รูป และวิดีโอ 3 ไฟล์", fileCount: "เพิ่มแล้ว {{count}} ไฟล์", chooseFiles: "เลือกไฟล์", addPhotosTitle: "เพิ่มรูปหรือวิดีโอ", uploadLimits: "รูปสูงสุด 10 รูป (ไฟล์ละ 8 MB) และวิดีโอ 3 ไฟล์ (ไฟล์ละ 64 MB)", filesReady: "พร้อมแล้ว {{count}} ไฟล์", reorderHint: "ลากเพื่อเรียงลำดับ ไฟล์แรกจะเป็นภาพปก", addMore: "เพิ่มอีก", openMedia: "เปิด {{name}} เพื่อเพิ่มหมายเหตุ", removeFile: "ลบ {{name}}", imageLimit: "เพิ่มรูปได้สูงสุด 10 รูป", videoLimit: "เพิ่มวิดีโอได้สูงสุด 3 ไฟล์", showComment: "แสดงความเห็น {{label}} บนไฟล์", editComment: "แก้ไขความเห็น {{label}}", deleteComment: "ลบความเห็น {{label}}", deleteCommentConfirm: "ลบความเห็น {{label}}? สามารถเลิกทำภายหลังได้", videoAt: "วิดีโอที่ {{time}}", imageNumber: "รูป {{number}}", unableUpdateComment: "อัปเดตความเห็นไม่สำเร็จ", unableDeleteComment: "ลบความเห็นไม่สำเร็จ", unableRestoreComment: "กู้คืนความเห็นไม่สำเร็จ", comment: "ความเห็น {{label}}", positionChanged: "เปลี่ยนตำแหน่งแล้ว", mediaNumber: "แสดงไฟล์ {{number}}", describeIssue: "อธิบายสิ่งที่เกิดขึ้นตรงนี้", markPoint: "ทำเครื่องหมายตำแหน่งที่มีปัญหา", placePin: "แตะบนรูปเพื่อวางจุด", moveComment: "แตะตำแหน่งใหม่เพื่อย้ายความเห็น", unableMoveComment: "ย้ายความเห็นไม่สำเร็จ", unableSaveComment: "บันทึกความเห็นไม่สำเร็จ", previousSlide: "ไฟล์ก่อนหน้า", nextSlide: "ไฟล์ถัดไป", closeDialog: "ปิดหน้าต่าง", reload: "โหลดใหม่", appError: "เกิดข้อผิดพลาด", appErrorDescription: "โหลดแอปใหม่เพื่อกลับไปทำงานต่อ",

  // Sign-in surfaces
  chooseAccountType: "เข้าสู่ระบบแบบไหน",
  chooseAccountTypeDescription: "เลือกพื้นที่ให้ตรงกับสิ่งที่คุณต้องการทำ",
  staffAccess: "เจ้าหน้าที่",
  staffAccessDescription: "จัดการและอัปเดตเรื่องทั้งหมด",
  customerAccess: "ลูกค้า",
  customerAccessDescription: "แจ้งเรื่องและติดตามความคืบหน้า",
  staffSignIn: "เข้าสู่ระบบสำหรับเจ้าหน้าที่",
  staffSignInDescription: "กรอกรหัสผ่านร่วมเพื่อเข้ากระดานภายใน",
  customerSignIn: "เข้าสู่ระบบสำหรับลูกค้า",
  customerSignInDescription: "ดูเรื่องของคุณและแจ้งเรื่องใหม่",
  customerSignUp: "สร้างบัญชีลูกค้า",
  customerSignUpDescription: "ใช้อีเมลและรหัสผ่านเพื่อติดตามเรื่องของคุณเอง",
  email: "อีเมล",
  newPassword: "รหัสผ่าน",
  confirmPassword: "ยืนยันรหัสผ่าน",
  passwordRules: "สั้นสุด 10 ตัวอักษร โดยมีตัวอักษรและตัวเลข",
  signIn: "เข้าสู่ระบบ",
  createAccount: "สร้างบัญชี",
  creatingAccount: "กำลังสร้างบัญชี…",
  haveAccountQuestion: "มีบัญชีอยู่แล้ว?",
  noAccountQuestion: "ยังไม่มีบัญชี?",
  useStaffPassword: "เข้าสู่ระบบเจ้าหน้าที่แทน",
  useCustomerAccount: "เข้าสู่ระบบลูกค้าแทน",

  // Customer portal
  customerPortal: "เรื่องของฉัน",
  customerPortalSubtitle: "เรื่องที่คุณแจ้งไว้",
  customerSupport: "ฝ่ายดูแลลูกค้า",
  customerPortalTitle: "วันนี้ให้เราช่วยอะไรได้บ้าง?",
  customerPortalIntro: "แจ้งเรื่องได้ในไม่กี่ขั้นตอน ติดตามความคืบหน้า และดูได้ทันทีเมื่อทีมงานต้องการข้อมูลเพิ่มเติมจากคุณ",
  signedInAs: "เข้าสู่ระบบเป็น {{email}}",
  newTicket: "แจ้งเรื่องใหม่",
  yourTickets: "เรื่องของคุณ",
  ticketSummary: "สรุปเรื่อง",
  filterTickets: "กรองเรื่อง",
  allTickets: "ทั้งหมด",
  activeTickets: "กำลังดำเนินการ",
  awaitingReply: "รอข้อมูลจากคุณ",
  awaitingReplyShort: "รอตอบ",
  resolvedTickets: "แก้ไขแล้ว",
  syncingTickets: "กำลังเตรียมเรื่องของคุณ…",
  noFilteredTickets: "ไม่มีเรื่องในมุมมองนี้",
  showAllTickets: "แสดงเรื่องทั้งหมด",
  openTicket: "ดูรายละเอียด",
  statusNextNew: "ได้รับเรื่องแล้ว — ทีมงานจะตรวจสอบเร็วๆ นี้",
  statusNextAcknowledged: "ทีมงานรับทราบเรื่องแล้ว",
  statusNextInProgress: "ทีมงานกำลังดำเนินการ",
  statusNextWaiting: "ตอบกลับเพื่อช่วยให้เรื่องดำเนินต่อ",
  statusNextDone: "เรื่องนี้ได้รับการแก้ไขแล้ว",
  myTicketsEmpty: "คุณยังไม่มีเรื่องที่แจ้งไว้",
  myTicketsEmptyHint: "แจ้งเรื่องเพื่อส่งรายละเอียด รูป หรือวิดีโอให้ทีมงาน",
  myTicketCount: "ทั้งหมด {{count}} เรื่อง",
  viewTicket: "เปิดเรื่อง {{ticket}}",
  editTicket: "แก้ไขเรื่อง",
  deleteTicket: "ลบเรื่อง",
  deleteTicketConfirm: "ลบเรื่องนี้? ทีมงานเก็บไว้ในคลัง 30 วัน",
  ticketDeleted: "ลบเรื่องแล้ว",
  ticketStatus: "สถานะ",
  customerStatusHint: "ทีมงานจะอัปเดตสถานะตามความคืบหน้า",
  updatedOn: "อัปเดตเมื่อ {{date}}",

  // Three-step customer ticket flow
  stepDetails: "รายละเอียด",
  stepMedia: "รูปและวิดีโอ",
  stepReview: "ตรวจสอบและส่ง",
  stepNumber: "ขั้นตอนที่ {{number}}",
  stepDetailsHint: "เริ่มด้วยหัวข้อสั้นๆ แล้วเพิ่มรายละเอียดที่จะช่วยให้ทีมงานเข้าใจสิ่งที่เกิดขึ้น",
  stepMediaHint: "ไม่จำเป็นต้องเพิ่มรูปหรือวิดีโอ แต่ไฟล์เหล่านี้จะช่วยให้ทีมงานเข้าใจปัญหาได้ง่ายขึ้น",
  stepReviewHint: "ตรวจสอบข้อมูลให้เรียบร้อย คุณสามารถย้อนกลับไปแก้ไขได้ก่อนส่งเรื่อง",
  topicPlaceholder: "ตัวอย่าง: เครื่องพิมพ์ใบเสร็จออฟไลน์",
  descriptionPlaceholder: "เกิดอะไรขึ้น? เริ่มเมื่อไร? คุณลองแก้ไขอะไรไปแล้วบ้าง?",
  stepCompleted: "เสร็จแล้ว",
  stepActive: "กำลังทำ",
  stepPending: "รอดำเนินการ",
  next: "ต่อไป",
  skipForNow: "ข้ามก่อน",
  back: "กลับ",
  reviewTopic: "หัวข้อ",
  reviewDescription: "รายละเอียด",
  reviewMedia: "แนบไฟล์ {{count}} ไฟล์",
  reviewPins: "เพิ่มหมายเหตุบนรูปแล้ว {{count}} จุด",
  reviewNoPins: "ยังไม่มีหมายเหตุบนรูป",
  submitTicket: "ส่งเรื่อง",
  requiredTitle: "ต้องกรอกหัวข้อ",
  requiredMedia: "ต้องเพิ่มรูปหรือวิดีโออย่างน้อย 1 ไฟล์",
  titleTooLong: "หัวข้อต้องไม่เกิน 100 ตัวอักษร",
  descriptionTooLong: "รายละเอียดยาวเกินไป",

  // Staff board
  dragTicket: "ลากเรื่อง {{ticket}}",
  boardColumnCards: "มี {{count}} รายการใน{{status}}",
  boardStatusTabs: "แสดงรายการตามสถานะ",
  ticketProgress: "ความคืบหน้าของ {{ticket}}: ขั้นที่ {{step}} จาก {{total}} คืบหน้า {{percent}}%",
  ticketStep: "ขั้นที่ {{step}}/{{total}}",
  moveConflict: "มีคนอื่นอัปเดตเรื่องนี้แล้ว กระดานจึงรีเฟรชใหม่",

  // Errors shared by both portals
  staffOnlyAction: "การดำเนินการนี้สำหรับเจ้าหน้าที่เท่านั้น",
  customerOnlyAction: "การดำเนินการนี้สำหรับบัญชีลูกค้าเท่านั้น",
  ticketMissing: "ไม่พบเรื่องนี้แล้ว",
  invalidEmail: "กรอกอีเมลให้ถูกต้อง",
  weakPassword: "รหัสผ่านต้องมีอย่างน้อย 10 ตัว และมีทั้งตัวอักษรและตัวเลข",
  passwordTooLongError: "รหัสผ่านต้องไม่เกิน 128 ตัวอักษร",
  emailTaken: "อีเมลนี้มีบัญชีอยู่แล้ว",
  invalidCredentials: "อีเมลหรือรหัสผ่านไม่ถูกต้อง",
  passwordMismatch: "รหัสผ่านสองช่องไม่ตรงกัน",
  uploadIntentInvalid: "รอบการอัปโหลดหมดอายุ กรุณาลองอีกครั้ง",
  uploadIncomplete: "อัปโหลดไฟล์ยังไม่เสร็จสมบูรณ์ กรุณาลองอีกครั้ง",
  mediaLimitExceeded: "เพิ่มรูปได้สูงสุด 10 รูป และวิดีโอ 3 ไฟล์",
  accountsUnavailable: "ระบบบัญชีลูกค้ายังใช้งานไม่ได้ กรุณาติดต่อทีมงาน",
  commentMissing: "ไม่พบความเห็นนี้แล้ว",
  undoUnavailable: "ไม่สามารถเลิกทำรายการนี้ได้แล้ว",
  invalidFile: "ไฟล์นี้ใช้ไม่ได้ กรุณาเลือกไฟล์อื่น",
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

/** Stable server and client error codes mapped to localized copy. */
const errorKeys: Record<string, Key> = {
  SESSION_EXPIRED: "sessionExpired",
  INCORRECT_PASSWORD: "incorrectPassword",
  AUTH_RATE_LIMITED: "rateLimited",
  INVALID_SIGNIN_CLIENT: "genericError",
  REQUIRED_FEEDBACK: "requiredFeedback",
  IMAGE_VIDEO_ONLY: "imageVideoOnly",
  IMAGE_TOO_LARGE: "imageTooLarge",
  VIDEO_TOO_LARGE: "videoTooLarge",
  MEDIA_LIMIT_EXCEEDED: "mediaLimitExceeded",
  INVALID_MEDIA_REFERENCE: "uploadIntentInvalid",
  UPLOAD_INTENT_INVALID: "uploadIntentInvalid",
  UPLOAD_INTENT_NOT_FOUND: "uploadIntentInvalid",
  UPLOAD_INCOMPLETE: "uploadIncomplete",
  UPLOAD_VERIFICATION_FAILED: "uploadIntentInvalid",
  UPLOAD_CLEANUP_FAILED: "uploadCleanupFailed",
  UPLOAD_FILE_MISMATCH: "uploadIntentInvalid",
  INVALID_UPLOAD_REQUEST: "uploadIntentInvalid",
  INVALID_UPLOADED_FILE: "invalidFile",
  INVALID_FILE_METADATA: "invalidFile",
  MEDIA_UNAVAILABLE: "mediaUnavailable",
  CREATE_FEEDBACK_FAILED: "submitFailed",
  REQUIRED_TITLE: "requiredTitle",
  REQUIRED_MEDIA: "requiredMedia",
  TITLE_TOO_LONG: "titleTooLong",
  DESCRIPTION_TOO_LONG: "descriptionTooLong",
  VERSION_CONFLICT: "moveConflict",
  FEEDBACK_NOT_FOUND: "ticketMissing",
  ARCHIVED_FEEDBACK_NOT_FOUND: "ticketMissing",
  COMMENT_NOT_FOUND: "commentMissing",
  COMMENT_UNDO_UNAVAILABLE: "undoUnavailable",
  EDIT_UNDO_UNAVAILABLE: "undoUnavailable",
  STATUS_UNDO_UNAVAILABLE: "undoUnavailable",
  STAFF_ONLY: "staffOnlyAction",
  CUSTOMER_ONLY: "customerOnlyAction",
  CUSTOMER_ACCOUNTS_UNAVAILABLE: "accountsUnavailable",
  INVALID_EMAIL: "invalidEmail",
  WEAK_PASSWORD: "weakPassword",
  PASSWORD_TOO_LONG: "passwordTooLongError",
  EMAIL_ALREADY_REGISTERED: "emailTaken",
  INVALID_CREDENTIALS: "invalidCredentials",
  PASSWORD_MISMATCH: "passwordMismatch",
  INVALID_PASSWORD_RECORD: "genericError",
};

/**
 * Codes ordered longest-first, so a wrapped message containing a more specific
 * code (`ARCHIVED_FEEDBACK_NOT_FOUND`) is never matched by a shorter code that
 * happens to be a substring of it (`FEEDBACK_NOT_FOUND`).
 */
const errorCodesBySpecificity = Object.keys(errorKeys).sort((left, right) => right.length - left.length);

export function localizeError(error: unknown, t: I18n["t"]) {
  const raw = error instanceof Error ? error.message : "";
  // Candidates come from Object.keys, so a message like "toString" cannot reach
  // an inherited property. Convex wraps server errors, so after the exact match
  // the code is also looked for anywhere in the message.
  const code = errorCodesBySpecificity.find((candidate) => candidate === raw)
    ?? errorCodesBySpecificity.find((candidate) => raw.includes(candidate));
  return code ? t(errorKeys[code]) : t("genericError");
}

export const translations = { en, th };
