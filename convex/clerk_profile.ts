// The OAuth component validates issuer, audience, expiry and state during the
// server-side code exchange. Keep provider identities distinct across instances.
export function clerkProfile(issuer: string, claims?: { sub: string; email?: string; email_verified?: boolean | string; name?: string }) {
  if (!claims || !claims.sub) throw new Error("INVALID_PROFILE");
  return {
    id: issuer + "|" + claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true,
    name: claims.name,
  };
}
