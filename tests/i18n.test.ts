import { ConvexError } from "convex/values";
import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalizedDate, localizeError, resolveLanguage, translate, translations } from "../src/lib/i18n";

test("Thai and English cover exactly the same keys with real copy", () => {
  const en = Object.keys(translations.en).sort();
  const th = Object.keys(translations.th).sort();
  assert.deepEqual(th, en);
  assert.equal(en.length > 0, true);
  for (const key of en) {
    const english = translations.en[key as keyof typeof translations.en];
    const thai = translations.th[key as keyof typeof translations.th];
    assert.equal(english.trim().length > 0, true, `empty English copy for ${key}`);
    assert.equal(thai.trim().length > 0, true, `empty Thai copy for ${key}`);
    // Placeholders must survive translation or interpolation silently breaks.
    const placeholders = (value: string) => (value.match(/{{\w+}}/g) ?? []).sort();
    assert.deepEqual(placeholders(thai), placeholders(english), `placeholder mismatch for ${key}`);
  }
});

test("new customer portal and board screens are translated in both languages", () => {
  const keys = [
    "staffSignIn",
    "customerSignIn",
    "customerSignUp",
    "customerPortal",
    "newTicket",
    "myTicketsEmpty",
    "deleteTicket",
    "stepDetails",
    "stepMedia",
    "stepReview",
    "submitTicket",
    "dragTicket",
    "acknowledged",
    "boardStatusTabs",
    "ticketProgress",
    "ticketStep",
    "urgencyScore",
    "urgencyScoreShort",
    "urgencyUnscored",
    "saveUrgency",
    "versionConflict",
    "invalidCredentials",
  ] as const;
  for (const key of keys) {
    assert.notEqual(translate("th", key), translate("en", key), `Thai copy missing for ${key}`);
  }
  assert.equal(translate("en", "stepNumber", { number: 2 }), "Step 2");
  assert.match(translate("th", "stepNumber", { number: 2 }), /2/);
});

test("Thai is the default persisted language and English is retained", () => {
  assert.equal(resolveLanguage(null), "th");
  assert.equal(resolveLanguage("unexpected"), "th");
  assert.equal(resolveLanguage("en"), "en");
});

test("translations interpolate in Thai and English", () => {
  assert.equal(translate("th", "ticketItems", { count: 3 }), "รายการแจ้งปัญหา 3 รายการ");
  assert.equal(translate("en", "ticketItems", { count: 3 }), "3 Tickets");
  assert.equal(translate("th", "description"), "รายละเอียด (ไม่บังคับ)");
  assert.equal(translate("en", "description"), "Description (optional)");
  assert.equal(translate("th", "noDescription"), "ไม่มีรายละเอียด");
  assert.equal(translate("en", "noDescription"), "No description provided.");
  assert.equal(translate("th", "requiredTicket"), "ต้องกรอกหัวข้อ");
  assert.equal(translate("en", "requiredTicket"), "A topic is required.");
});

test("stable error codes are localized", () => {
  const thai = (key: Parameters<typeof translate>[1]) => translate("th", key);
  const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
  assert.equal(localizeError(new Error("SESSION_EXPIRED"), thai), "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  assert.equal(localizeError(new Error("IMAGE_TOO_LARGE"), english), "Images must be 8MB or smaller.");
  assert.equal(localizeError(new ConvexError({ code: "ANNOTATION_LIMIT_EXCEEDED" }), english), translate("en", "annotationLimitExceeded"));
  assert.equal(localizeError(new ConvexError({ code: "REQUEST_ID_CONFLICT" }), thai), translate("th", "requestIdConflict"));
  assert.equal(
    localizeError(new Error("UPLOAD_INCOMPLETE"), thai),
    "อัปโหลดไฟล์ยังไม่เสร็จสมบูรณ์ กรุณาลองอีกครั้ง",
  );
  assert.equal(localizeError(new Error("UNKNOWN_CODE"), thai), "เกิดข้อผิดพลาด โปรดลองอีกครั้ง");
});

test("authorization and account error codes are localized, including structured Convex errors", () => {
  const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
  assert.equal(localizeError(new Error("STAFF_ONLY"), english), translate("en", "staffOnlyAction"));
  assert.equal(localizeError(new Error("CUSTOMER_ONLY"), english), translate("en", "customerOnlyAction"));
  assert.equal(localizeError(new Error("TICKET_UNAVAILABLE"), english), translate("en", "ticketMissing"));
  assert.equal(localizeError(new Error("INVALID_EMAIL"), english), translate("en", "invalidEmail"));
  assert.equal(localizeError(new Error("WEAK_PASSWORD"), english), translate("en", "weakPassword"));
  assert.equal(localizeError(new Error("EMAIL_ALREADY_REGISTERED"), english), translate("en", "emailTaken"));
  assert.equal(localizeError(new Error("INVALID_CREDENTIALS"), english), translate("en", "invalidCredentials"));
  assert.equal(
    localizeError(new Error("CUSTOMER_ACCOUNTS_UNAVAILABLE"), english),
    translate("en", "accountsUnavailable"),
  );
  assert.equal(localizeError(new Error("VERSION_CONFLICT"), english), translate("en", "versionConflict"));
  assert.equal(localizeError(new Error("REQUIRED_MEDIA"), english), translate("en", "requiredMedia"));
  // Public handlers return structured data; text mentioning a code is not authoritative.
  assert.equal(
    localizeError(new ConvexError({ code: "STAFF_ONLY" }), english),
    translate("en", "staffOnlyAction"),
  );
});

test("error messages cannot impersonate a structured domain rejection", () => {
  const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
  assert.equal(localizeError(new Error("Server Error STAFF_ONLY"), english), translate("en", "genericError"));
});

test("annotation and detail version conflicts use accurate copy in both languages", () => {
  for (const language of ["en", "th"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    const copy = localizeError(new ConvexError({ code: "VERSION_CONFLICT" }), t);
    assert.equal(copy, t("versionConflict"));
    assert.doesNotMatch(copy, /board|กระดาน|รีเฟรช/i);
  }
});

test("Thai dates use Buddhist Era years", () => {
  const timestamp = Date.UTC(2026, 0, 2, 3, 4);
  assert.match(formatLocalizedDate("th", timestamp), /2569/);
  assert.match(formatLocalizedDate("en", timestamp), /2026/);
});


test("cleanup uncertainty, mismatched intent and invalid media index have localized errors", () => {
  for (const language of ["en", "th"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    for (const code of ["UPLOAD_CLEANUP_UNKNOWN", "UPLOAD_INTENT_MISMATCH", "INVALID_MEDIA_INDEX", "UPLOAD_CALLBACK_NOT_CONFIGURED"]) {
      assert.notEqual(localizeError(new ConvexError({ code }), t), t("genericError"));
    }
  }
});

test("unknown writes and media ownership failures have localized recovery messages", () => {
  for (const language of ["en", "th"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    for (const code of ["UPLOAD_WRITE_UNKNOWN", "UPLOAD_RECORDING_UNKNOWN", "MEDIA_OWNERSHIP_CONFLICT", "MEDIA_NOT_ATTACHABLE", "UPLOAD_REQUEST_CONFLICT"]) {
      assert.notEqual(localizeError(new Error(code), t), t("genericError"));
    }
  }
});


test("submission conflicts use customer wording in both languages", () => {
  for (const language of ["en", "th"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    for (const code of ["REQUEST_ID_CONFLICT", "UPLOAD_REQUEST_CONFLICT"]) {
      assert.doesNotMatch(localizeError(new ConvexError({ code }), t), /request.?id|รหัสคำขอ/i);
    }
  }
});
