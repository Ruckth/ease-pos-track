import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { validateFiles } from "../shared/media-policy";
import { createAnnotationRecord, updateAnnotationRecord } from "../convex/annotation_state";
import {
  MEDIA_POLICY, isTicketSearchWithinLimits, normalizeTicketRequest, ticketRequestFingerprintInput, transitionTicketJob,
  type JobTransition, type TicketJob, type TicketRequestInput,
} from "../shared/ticket-contracts";

const request: TicketRequestInput = {
  actor: { role: "customer", customerId: "customer-1" as Id<"customers"> },
  projectId: "project-1" as Id<"projects">,
  title: "  Printer jams  ", description: "  Long receipts\nstop printing  ",
};

test("search limits keep Thai combining marks with their letters", () => {
  for (const search of ["หน้าจอค้าง เมื่อกดปุ่มชำระเงิน ที่สาขาสีลม", "เครื่องพิมพ์ไม่ออกใบเสร็จ"]) {
    assert.equal(isTicketSearchWithinLimits(search), true, search);
  }
  assert.equal(isTicketSearchWithinLimits("เมื่อกดปุ่ม ".repeat(16).trim()), true);
  assert.equal(isTicketSearchWithinLimits("เมื่อกดปุ่ม ".repeat(17).trim()), false);
  assert.equal(isTicketSearchWithinLimits("word ".repeat(17).trim()), false);
  assert.equal(isTicketSearchWithinLimits("x".repeat(201)), false);
});

test("request normalization trims text and defaults arrays without mutating input", () => {
  const before = structuredClone(request);
  assert.deepEqual(normalizeTicketRequest(request), {
    operation: "ticket.create", actor: request.actor, projectId: request.projectId,
    title: "Printer jams", description: "Long receipts\nstop printing", mediaKeys: [], annotations: [],
  });
  assert.deepEqual(request, before);
  assert.equal(ticketRequestFingerprintInput(request), ticketRequestFingerprintInput({
    ...request, title: "Printer jams", description: "Long receipts\nstop printing", annotations: [], mediaKeys: [],
  }));
});

test("fingerprint input has a stable encoding independent of property insertion order", () => {
  assert.equal(ticketRequestFingerprintInput(request),
    '{"operation":"ticket.create","actor":{"role":"customer","customerId":"customer-1"},"projectId":"project-1","title":"Printer jams","description":"Long receipts\\nstop printing","mediaKeys":[],"annotations":[]}');
  assert.equal(ticketRequestFingerprintInput(request), ticketRequestFingerprintInput({
    description: request.description, title: request.title, projectId: request.projectId,
    actor: { customerId: "customer-1" as Id<"customers">, role: "customer" },
  }));
});

test("fingerprints distinguish actor, Project and content and do not depend on the current Ticket", () => {
  const original = ticketRequestFingerprintInput(request);
  const edited = { ...request, title: "Changed later" };
  for (const changed of [
    edited, { ...request, description: "Different" },
    { ...request, projectId: "project-2" as Id<"projects"> },
    { ...request, actor: { role: "staff" as const } },
    { ...request, actor: { role: "customer" as const, customerId: "customer-2" as Id<"customers"> } },
  ]) assert.notEqual(original, ticketRequestFingerprintInput(changed));
  assert.equal(original, ticketRequestFingerprintInput(request));
});

test("media order and annotation edits affect fingerprints; normalization copies nested input", () => {
  const input: TicketRequestInput = {
    ...request, mediaKeys: ["key-a", "key-b"],
    annotations: [{ mediaIndex: 0, kind: "point", x: 0.1, y: 0.2, text: "  Here  " }],
  };
  const before = structuredClone(input);
  const original = ticketRequestFingerprintInput(input);
  assert.equal(original, ticketRequestFingerprintInput({
    ...input, annotations: [{ text: "Here", y: 0.2, x: 0.1, kind: "point", mediaIndex: 0 }],
  }));
  assert.notEqual(original, ticketRequestFingerprintInput({ ...input, mediaKeys: ["key-b", "key-a"] }));
  assert.notEqual(original, ticketRequestFingerprintInput({
    ...input, annotations: [{ ...input.annotations![0], text: "Elsewhere" }],
  }));
  const normalized = normalizeTicketRequest(input);
  normalized.actor.role = "staff";
  normalized.mediaKeys.push("key-c");
  normalized.annotations[0].text = "Changed";
  assert.deepEqual(input, before);
});

// Exercise the existing runtime validators so changing either side's limits fails.
for (const kind of ["image", "video"] as const) {
  const policy = MEDIA_POLICY[kind];
  const file = { name: "file", size: 1, type: `${kind}/test` };
  test(`${kind} byte and count limits match MEDIA_POLICY`, () => {
    assert.doesNotThrow(() => validateFiles([{ ...file, size: policy.maxBytes }]));
    assert.throws(() => validateFiles([{ ...file, size: policy.maxBytes + 1 }]), {
      message: kind === "image" ? "IMAGE_TOO_LARGE" : "VIDEO_TOO_LARGE",
    });
    assert.doesNotThrow(() => validateFiles(Array.from({ length: policy.maxCount }, () => file)));
    assert.throws(() => validateFiles(Array.from({ length: policy.maxCount + 1 }, () => file)), {
      message: "MEDIA_LIMIT_EXCEEDED",
    });
  });
}

test("file metadata limits match MEDIA_POLICY", () => {
  const file = { name: "a".repeat(MEDIA_POLICY.maxFileNameLength), size: 1,
    type: "image/" + "a".repeat(MEDIA_POLICY.maxMimeTypeLength - "image/".length) };
  assert.doesNotThrow(() => validateFiles([file]));
  assert.throws(() => validateFiles([{ ...file, name: file.name + "a" }]), { message: "INVALID_FILE_METADATA" });
  assert.throws(() => validateFiles([{ ...file, type: file.type + "a" }]), { message: "INVALID_FILE_METADATA" });
});

test("annotation creation and update text limits match MEDIA_POLICY", () => {
  const input = { mediaIndex: 0, kind: "point" as const, x: 0.1, y: 0.2,
    text: "a".repeat(MEDIA_POLICY.maxAnnotationTextLength) };
  const annotation = createAnnotationRecord([{ type: "image/png" }], input, 1, "annotation-1", 100);
  assert.equal(annotation.text, input.text);
  assert.throws(() => createAnnotationRecord([{ type: "image/png" }], {
    ...input, text: input.text + "a",
  }, 1, "annotation-1", 100), { message: "COMMENT_TOO_LONG" });
  assert.equal(updateAnnotationRecord(annotation, { text: input.text }, 101).text, input.text);
  assert.throws(() => updateAnnotationRecord(annotation, { text: input.text + "a" }, 101), {
    message: "COMMENT_TOO_LONG",
  });
});

const pending: TicketJob = { state: "pending", attempt: 0, availableAt: 100, maxAttempts: 2 };
const claim: JobTransition = { kind: "claim", now: 100, leaseId: "lease-1", leaseExpiresAt: 200 };
const leased: TicketJob = { state: "leased", attempt: 1, leaseId: "lease-1", leaseExpiresAt: 200, maxAttempts: 2 };
const fence = { attempt: 1, leaseId: "lease-1" };

test("jobs claim only available pending work or expired leases and increment attempts", () => {
  assert.deepEqual(transitionTicketJob(pending, claim), { accepted: true, job: leased });
  assert.deepEqual(transitionTicketJob(pending, { ...claim, now: 99 }), { accepted: false, reason: "not_ready" });
  assert.deepEqual(transitionTicketJob(leased, claim), { accepted: false, reason: "not_ready" });
  assert.deepEqual(transitionTicketJob(leased, { ...claim, now: 200, leaseId: "lease-2", leaseExpiresAt: 300 }), {
    accepted: true, job: { state: "leased", attempt: 2, leaseId: "lease-2", leaseExpiresAt: 300, maxAttempts: 2 },
  });
  assert.deepEqual(pending, { state: "pending", attempt: 0, availableAt: 100, maxAttempts: 2 });
});

test("job settlement requires both the current lease and attempt before expiry", () => {
  const settle: JobTransition = { kind: "settle", now: 199, fence, outcome: "succeeded" };
  assert.deepEqual(transitionTicketJob(leased, settle), { accepted: true, job: { state: "succeeded", attempt: 1, maxAttempts: 2 } });
  for (const event of [
    { ...settle, now: 200 },
    { ...settle, fence: { ...fence, attempt: 0 } },
    { ...settle, fence: { ...fence, leaseId: "old-lease" } },
  ]) assert.deepEqual(transitionTicketJob(leased, event), { accepted: false, reason: "stale_lease" });
  assert.deepEqual(transitionTicketJob(pending, settle), { accepted: false, reason: "stale_lease" });
  // Even reusing a lease ID cannot let the old attempt settle a replacement.
  assert.deepEqual(transitionTicketJob({ ...leased, attempt: 2, leaseExpiresAt: 300 }, {
    ...settle, now: 201,
  }), { accepted: false, reason: "stale_lease" });
});

test("retryable or unknown work returns to pending; stale retries cannot release the lease", () => {
  const retry: JobTransition = { kind: "retry", now: 150, fence, availableAt: 250 };
  assert.deepEqual(transitionTicketJob(leased, retry), {
    accepted: true, job: { state: "pending", attempt: 1, availableAt: 250, maxAttempts: 2 },
  });
  assert.deepEqual(transitionTicketJob(leased, { ...retry, fence: { ...fence, attempt: 2 } }), {
    accepted: false, reason: "stale_lease",
  });
  assert.deepEqual(transitionTicketJob(leased, { ...retry, now: 200 }), { accepted: false, reason: "stale_lease" });
});

test("attempt limits exhaust retry and expired-lease recovery; permanent failure is terminal", () => {
  assert.deepEqual(transitionTicketJob({ ...leased, maxAttempts: 1 }, { kind: "retry", now: 150, fence, availableAt: 250 }), {
    accepted: true, job: { state: "exhausted", attempt: 1, maxAttempts: 1 },
  });
  assert.deepEqual(transitionTicketJob({ ...leased, attempt: 2 }, {
    ...claim, now: 200, leaseExpiresAt: 300,
  }), { accepted: true, job: { state: "exhausted", attempt: 2, maxAttempts: 2 } });
  assert.deepEqual(transitionTicketJob(leased, { kind: "settle", now: 150, fence, outcome: "failed" }), {
    accepted: true, job: { state: "failed", attempt: 1, maxAttempts: 2 },
  });
});

test("cancellation is allowed before a claim or after lease expiry; terminal states never restart", () => {
  assert.deepEqual(transitionTicketJob(pending, { kind: "cancel", now: 99 }), {
    accepted: true, job: { state: "cancelled", attempt: 0, maxAttempts: 2 },
  });
  assert.deepEqual(transitionTicketJob(leased, { kind: "cancel", now: 199 }), { accepted: false, reason: "leased" });
  for (const now of [200, 201]) {
    assert.deepEqual(transitionTicketJob(leased, { kind: "cancel", now }), {
      accepted: true, job: { state: "cancelled", attempt: 1, maxAttempts: 2 },
    });
  }
  for (const state of ["succeeded", "failed", "exhausted", "cancelled"] as const) {
    for (const event of [claim, { kind: "cancel", now: 200 } as const]) {
      assert.deepEqual(transitionTicketJob({ state, attempt: 1, maxAttempts: 2 }, event), { accepted: false, reason: "terminal" });
    }
  }
});

test("claims, retries and cancellations reject invalid event input", () => {
  for (const change of [
    { leaseId: "" }, { leaseExpiresAt: 100 }, { leaseExpiresAt: Infinity }, { now: NaN },
  ]) assert.deepEqual(transitionTicketJob(pending, { ...claim, ...change }), { accepted: false, reason: "invalid_event" });
  for (const availableAt of [149, NaN, Infinity]) {
    assert.deepEqual(transitionTicketJob(leased, {
      kind: "retry", now: 150, fence, availableAt,
    }), { accepted: false, reason: "invalid_event" });
  }
  for (const job of [pending, leased]) {
    assert.deepEqual(transitionTicketJob(job, { kind: "cancel", now: NaN }), { accepted: false, reason: "invalid_event" });
  }
});

test("job transitions reject a job without a positive integer maxAttempts", () => {
  for (const maxAttempts of [Number.NaN, 0, -1, 1.5, undefined as unknown as number]) {
    assert.deepEqual(transitionTicketJob({ ...pending, maxAttempts }, claim), { accepted: false, reason: "invalid_job" });
  }
});
