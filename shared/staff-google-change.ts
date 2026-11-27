type StaffGoogleChange = { kind: "revoke" } | { kind: "replace"; replacement: { googleSubject: string; verifiedEmail: string } };

/** Shared with the Owner client requesting and then using fresh mailbox proof. */
export function staffGoogleChangeIntent(input: {
  staffId: string; expectedGeneration: number; expectedRole: "owner" | "staff"; change: StaffGoogleChange; evidenceRef: string;
}) {
  const destination = input.change.kind === "replace"
    ? [input.change.replacement.googleSubject, input.change.replacement.verifiedEmail]
    : [];
  return JSON.stringify([input.staffId, input.expectedGeneration, input.expectedRole, input.change.kind, ...destination, input.evidenceRef]);
}
