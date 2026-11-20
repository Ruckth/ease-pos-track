/** The proof purpose distinguishes creation from reissue. Reissue also binds the original link. */
export function staffInvitationIntent(email: string, role: "staff" | "owner", invitationId?: string) {
  return JSON.stringify([email.trim().toLowerCase(), role, invitationId ?? null]);
}
