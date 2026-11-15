import { localizeError, translate } from "../src/lib/i18n";
import assert from "node:assert/strict";
import test from "node:test";
import { ConvexError } from "convex/values";
import { TicketOperationFailure } from "../src/features/tickets/operations";

test("Ticket operations classify structured conflicts, safe rejections and unknown transport failures", () => {
  const conflict = new TicketOperationFailure(new ConvexError({ code: "VERSION_CONFLICT" }));
  assert.equal(conflict.disposition, "conflict");
  assert.equal(conflict.data.code, "VERSION_CONFLICT");
  const rejected = new TicketOperationFailure(new ConvexError({ code: "TICKET_UNAVAILABLE" }));
  assert.equal(rejected.disposition, "rejected");
  const unknown = new TicketOperationFailure(new Error("Server said VERSION_CONFLICT, stack and private details"));
  assert.equal(unknown.disposition, "unknown");
  assert.deepEqual(unknown.data, { code: "UNKNOWN_OUTCOME" });
  assert.equal(unknown.message, "UNKNOWN_OUTCOME");
  for (const language of ["en", "th"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(language, key);
    assert.equal(localizeError(conflict, t), t("versionConflict"));
    assert.equal(localizeError(rejected, t), t("ticketMissing"));
    assert.equal(localizeError(unknown, t), t("operationUnknown"));
  }
});
