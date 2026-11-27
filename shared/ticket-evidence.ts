export const MAX_EVIDENCE_ID_LENGTH = 256;

export type MessageEvidenceInput =
  | { kind: "media"; mediaKey: string }
  | { kind: "annotation"; annotationId: string };

/** Validates the wire shape of a same-Ticket evidence reference before Ticket lookup. */
export function normalizeMessageEvidence(evidence: MessageEvidenceInput | undefined): MessageEvidenceInput | undefined {
  if (!evidence) return undefined;
  const raw = evidence.kind === "media" ? evidence.mediaKey : evidence.annotationId;
  // eslint-disable-next-line no-control-regex
  if (!raw || raw.trim() !== raw || raw.length > MAX_EVIDENCE_ID_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(raw)) {
    throw new Error("INVALID_INPUT");
  }
  return evidence.kind === "media"
    ? { kind: "media", mediaKey: raw }
    : { kind: "annotation", annotationId: raw };
}

export function messageEvidenceKey(evidence: MessageEvidenceInput | undefined): string {
  if (!evidence) return "";
  return evidence.kind === "media" ? `media:${evidence.mediaKey}` : `annotation:${evidence.annotationId}`;
}
