const historyCopy = {
  en: {
    staff: "Staff", customer: "Customer", unknown: "Role unavailable",
    archived: "Archived", status: "Status", urgency: "Urgency score", unscored: "Unscored",
    tags: "Tags", title: "Title", description: "Description", before: "Before", after: "After",
    emptyValue: "Empty", textChanges: "Show text changes", showFull: "Show full text", showLess: "Show less",
    recentTicket: "Latest Ticket events (up to 30 initially)",
    recentNotes: "Latest note changes (up to 30 initially)",
    olderTicket: "Show older Ticket events", olderNotes: "Show older note changes",
  },
  th: {
    staff: "เจ้าหน้าที่", customer: "ลูกค้า", unknown: "ไม่ทราบบทบาท",
    archived: "เก็บเข้าคลังแล้ว", status: "สถานะ", urgency: "คะแนนความเร่งด่วน", unscored: "ยังไม่มีคะแนน",
    tags: "แท็ก", title: "หัวข้อ", description: "รายละเอียด", before: "ก่อนแก้ไข", after: "หลังแก้ไข",
    emptyValue: "ว่าง", textChanges: "ดูข้อความที่เปลี่ยน", showFull: "ดูข้อความทั้งหมด", showLess: "แสดงน้อยลง",
    recentTicket: "เหตุการณ์ล่าสุดของ Ticket (เริ่มต้นไม่เกิน 30 รายการ)",
    recentNotes: "การเปลี่ยนแปลงหมายเหตุล่าสุด (เริ่มต้นไม่เกิน 30 รายการ)",
    olderTicket: "ดูเหตุการณ์ก่อนหน้าของ Ticket", olderNotes: "ดูการเปลี่ยนแปลงหมายเหตุก่อนหน้า",
  },
} as const;

export function ticketHistoryCopy(language: keyof typeof historyCopy) {
  return historyCopy[language];
}
