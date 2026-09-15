import { useI18n } from "./i18n";

const en = {
  urgency: "Urgency", unset: "Unset",
  board: "Board", table: "Table", view: "Ticket view", filters: "Filters", clearAll: "Clear all", tags: "Tags", status: "Status",
  createdDate: "Created date", updatedDate: "Updated date", anyOf: "is any of", between: "between", from: "From", to: "Through",
  dateHint: "Includes both dates, in your local timezone.", semantics: "Filters combine with search. Each tag filter matches any selected tag.",
  invalidDate: "Choose valid dates with the end on or after the start.", apply: "Apply", cancel: "Cancel", title: "Title", ticketNumber: "Ticket number",
  noResults: "No Tickets match these filters.", results: "Tickets", page: "Page", of: "of", perPage: "Rows per page", previous: "Previous page", next: "Next page",
  first: "First page", last: "Last page", open: "Open Ticket", archived: "Archived", remove: "Remove", sort: "Sort", ascending: "Ascending", descending: "Descending",
};
const th: typeof en = {
  urgency: "ความเร่งด่วน", unset: "ยังไม่ระบุ",
  board: "บอร์ด", table: "ตาราง", view: "มุมมอง Ticket", filters: "ตัวกรอง", clearAll: "ล้างทั้งหมด", tags: "แท็ก", status: "สถานะ",
  createdDate: "วันที่สร้าง", updatedDate: "วันที่แก้ไข", anyOf: "ตรงกับรายการใดก็ได้", between: "ระหว่าง", from: "ตั้งแต่", to: "ถึง",
  dateHint: "รวมทั้งวันเริ่มต้นและวันสิ้นสุด ตามเขตเวลาของคุณ", semantics: "ตัวกรองใช้ร่วมกับคำค้นหา แต่ละตัวกรองแท็กจะตรงกับแท็กที่เลือกอย่างน้อยหนึ่งแท็ก",
  invalidDate: "เลือกวันที่ที่ถูกต้อง โดยวันสิ้นสุดไม่ก่อนวันเริ่มต้น", apply: "ใช้ตัวกรอง", cancel: "ยกเลิก", title: "หัวข้อ", ticketNumber: "หมายเลข Ticket",
  noResults: "ไม่พบ Ticket ที่ตรงกับตัวกรอง", results: "Ticket", page: "หน้า", of: "จาก", perPage: "แถวต่อหน้า", previous: "หน้าก่อนหน้า", next: "หน้าถัดไป",
  first: "หน้าแรก", last: "หน้าสุดท้าย", open: "เปิด Ticket", archived: "เก็บถาวร", remove: "นำออก", sort: "เรียงตาม", ascending: "น้อยไปมาก", descending: "มากไปน้อย",
};
export function useExplorerCopy() { const { language } = useI18n(); return language === "th" ? th : en; }
