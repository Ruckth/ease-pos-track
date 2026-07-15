import assert from "node:assert/strict";
import test from "node:test";
import { formatLocalizedDate, localizeError, resolveLanguage, translate } from "../src/lib/i18n";

test("Thai is the default persisted language and English is retained", () => {
  assert.equal(resolveLanguage(null), "th");
  assert.equal(resolveLanguage("unexpected"), "th");
  assert.equal(resolveLanguage("en"), "en");
});

test("translations interpolate in Thai and English", () => {
  assert.equal(translate("th", "feedbackItems", { count: 3 }), "รายการแจ้งปัญหา 3 รายการ");
  assert.equal(translate("en", "feedbackItems", { count: 3 }), "3 feedback items");
});

test("stable error codes are localized", () => {
  const thai = (key: Parameters<typeof translate>[1]) => translate("th", key);
  const english = (key: Parameters<typeof translate>[1]) => translate("en", key);
  assert.equal(localizeError(new Error("SESSION_EXPIRED"), thai), "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่");
  assert.equal(localizeError(new Error("IMAGE_TOO_LARGE"), english), "Images must be 8MB or smaller.");
  assert.equal(localizeError(new Error("UNKNOWN_CODE"), thai), "เกิดข้อผิดพลาด โปรดลองอีกครั้ง");
});

test("Thai dates use Buddhist Era years", () => {
  const timestamp = Date.UTC(2026, 0, 2, 3, 4);
  assert.match(formatLocalizedDate("th", timestamp), /2569/);
  assert.match(formatLocalizedDate("en", timestamp), /2026/);
});
