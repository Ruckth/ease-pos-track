import assert from "node:assert/strict";
import test from "node:test";
import { MAX_EVIDENCE_ID_LENGTH, messageEvidenceKey, normalizeMessageEvidence } from "../shared/ticket-evidence";

test("normalizeMessageEvidence accepts canonical file and annotation ids and rejects malformed inputs", () => {
  assert.equal(normalizeMessageEvidence(undefined), undefined);
  assert.deepEqual(normalizeMessageEvidence({ kind: "media", mediaKey: "file-key-1" }), { kind: "media", mediaKey: "file-key-1" });
  assert.deepEqual(normalizeMessageEvidence({ kind: "annotation", annotationId: "note-uuid-1" }), { kind: "annotation", annotationId: "note-uuid-1" });

  for (const invalid of [
    { kind: "media" as const, mediaKey: "" },
    { kind: "media" as const, mediaKey: "  file-key-1" },
    { kind: "media" as const, mediaKey: "file-key-1 " },
    { kind: "media" as const, mediaKey: "bad\u0007key" },
    { kind: "media" as const, mediaKey: "k".repeat(MAX_EVIDENCE_ID_LENGTH + 1) },
    { kind: "annotation" as const, annotationId: "" },
    { kind: "annotation" as const, annotationId: "\tnote" },
    { kind: "annotation" as const, annotationId: "note\n1" },
    { kind: "annotation" as const, annotationId: "n".repeat(MAX_EVIDENCE_ID_LENGTH + 1) },
  ]) {
    assert.throws(() => normalizeMessageEvidence(invalid), /INVALID_INPUT/);
  }
});

test("messageEvidenceKey separates media and annotation namespaces for replay comparison", () => {
  assert.equal(messageEvidenceKey(undefined), "");
  const media = messageEvidenceKey({ kind: "media", mediaKey: "same-id" });
  const annotation = messageEvidenceKey({ kind: "annotation", annotationId: "same-id" });
  assert.notEqual(media, annotation);
  assert.equal(media, "media:same-id");
  assert.equal(annotation, "annotation:same-id");
});
