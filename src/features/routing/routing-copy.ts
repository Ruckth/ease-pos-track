import { useI18n } from "@/lib/i18n";

const en = {
  routing: "Ticket routing", assignment: "Assignment", all: "All assignments", mine: "Mine", unassigned: "Unassigned",
  area: "Responsibility area", noArea: "No area", assignee: "Assignee", hold: "Hold routing", held: "Routing held",
  needsReview: "The assignee is unavailable. Review this assignment.", saveAssignment: "Save assignment", history: "Assignment history",
  product: "Product", symptom: "Symptom", unknown: "Unknown", restricted: "Require manual assignment", reviewClassification: "Review routing classification",
  classificationDetails: "Product and symptom (optional)",
  saveClassification: "Save classification",
  pendingReview: "Classification needs staff review", checkRule: "Check routing rule", manual: "This Ticket needs manual routing.",
  suggestionSaved: "Suggestion is ready for review.", suggestions: "Routing suggestions", noSuggestions: "No pending suggestions.",
  accept: "Accept", dismiss: "Dismiss", accepted: "Assignment saved.", dismissed: "Suggestion dismissed.",
  stale: "The suggestion is out of date.", rule: "Local rule", saved: "Saved",
  availability: "Availability", available: "Available", awayUntil: "Away until", setAvailability: "Save availability",
  override: "Change another person’s availability", reason: "Reason", settings: "Project routing settings",
  primary: "Primary staff", fallback: "Fallback staff", addStaff: "Add staff", remove: "Remove", moveUp: "Move up",
  intake: "Project intake staff", backup: "Intake backup", areas: "Responsibility areas", addArea: "Add area",
  products: "Product codes", symptoms: "Symptom codes", addCode: "Add code", code: "Code",
  english: "English label", thai: "Thai label", meaning: "Safe description", active: "Active", rules: "Product and symptom rules",
  addRule: "Add rule", saveSettings: "Save settings", directoryOverflow: "Select a roster of up to 50 staff.",
  select: "Select…",
};

const th: typeof en = {
  routing: "การจัดเส้นทาง Ticket", assignment: "การมอบหมาย", all: "การมอบหมายทั้งหมด", mine: "ของฉัน", unassigned: "ยังไม่มอบหมาย",
  area: "ขอบเขตความรับผิดชอบ", noArea: "ไม่ระบุขอบเขต", assignee: "ผู้รับผิดชอบ", hold: "พักการจัดเส้นทาง", held: "พักการจัดเส้นทางแล้ว",
  needsReview: "ผู้รับผิดชอบไม่พร้อม โปรดตรวจสอบการมอบหมายนี้", saveAssignment: "บันทึกการมอบหมาย", history: "ประวัติการมอบหมาย",
  product: "ผลิตภัณฑ์", symptom: "อาการ", unknown: "ไม่ทราบ", restricted: "ให้เจ้าหน้าที่เลือกผู้รับผิดชอบเอง", reviewClassification: "ตรวจสอบการจัดประเภท",
  classificationDetails: "ผลิตภัณฑ์และอาการ (ไม่บังคับ)",
  saveClassification: "บันทึกการจัดประเภท",
  pendingReview: "รอเจ้าหน้าที่ตรวจสอบการจัดประเภท", checkRule: "ตรวจสอบกฎการจัดเส้นทาง", manual: "Ticket นี้ต้องจัดเส้นทางด้วยตนเอง",
  suggestionSaved: "คำแนะนำพร้อมให้ตรวจสอบ", suggestions: "คำแนะนำการจัดเส้นทาง", noSuggestions: "ไม่มีคำแนะนำที่รอตรวจสอบ",
  accept: "ยอมรับ", dismiss: "ปิดคำแนะนำ", accepted: "บันทึกการมอบหมายแล้ว", dismissed: "ปิดคำแนะนำแล้ว",
  stale: "คำแนะนำหมดอายุหรือข้อมูลเปลี่ยนแล้ว", rule: "กฎในระบบ", saved: "บันทึกแล้ว",
  availability: "ความพร้อม", available: "พร้อมรับงาน", awayUntil: "ไม่อยู่จนถึง", setAvailability: "บันทึกความพร้อม",
  override: "เปลี่ยนความพร้อมของเจ้าหน้าที่คนอื่น", reason: "เหตุผล", settings: "การตั้งค่าการจัดเส้นทางของโครงการ",
  primary: "เจ้าหน้าที่หลัก", fallback: "เจ้าหน้าที่สำรอง", addStaff: "เพิ่มเจ้าหน้าที่", remove: "ลบ", moveUp: "เลื่อนขึ้น",
  intake: "เจ้าหน้าที่รับ Ticket เข้า", backup: "ผู้รับ Ticket เข้าสำรอง", areas: "ขอบเขตความรับผิดชอบ", addArea: "เพิ่มขอบเขต",
  products: "รหัสผลิตภัณฑ์", symptoms: "รหัสอาการ", addCode: "เพิ่มรหัส", code: "รหัส",
  english: "ชื่อภาษาอังกฤษ", thai: "ชื่อภาษาไทย", meaning: "คำอธิบายที่ปลอดภัย", active: "เปิดใช้งาน", rules: "กฎผลิตภัณฑ์และอาการ",
  addRule: "เพิ่มกฎ", saveSettings: "บันทึกการตั้งค่า", directoryOverflow: "เลือกเจ้าหน้าที่ในรายชื่อได้สูงสุด 50 คน",
  select: "เลือก…",
};

export function useRoutingCopy() {
  const { language } = useI18n();
  return { copy: language === "th" ? th : en, language };
}

export const routingSelect = "min-h-11 w-full rounded-md glass-field px-2 text-sm";
