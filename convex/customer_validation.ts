/**
 * Input rules for customer accounts. Pure so the same checks can be unit tested
 * and reused by the sign-up and sign-in paths.
 */

export const EMAIL_MAX_LENGTH = 254;
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeCustomerEmail(input: string) {
  return input.trim().toLowerCase();
}

export function validateCustomerEmail(input: string) {
  const email = normalizeCustomerEmail(input);
  if (!email || email.length > EMAIL_MAX_LENGTH || !EMAIL_PATTERN.test(email)) {
    throw new Error("INVALID_EMAIL");
  }
  return email;
}

/**
 * Length is the primary defence; a letter and a digit are required to block the
 * most common throwaway passwords without frustrating passphrases.
 */
export function validateCustomerPassword(input: string) {
  if (input.length < PASSWORD_MIN_LENGTH) throw new Error("WEAK_PASSWORD");
  if (input.length > PASSWORD_MAX_LENGTH) throw new Error("PASSWORD_TOO_LONG");
  if (!/[A-Za-z]/.test(input) || !/[0-9]/.test(input)) throw new Error("WEAK_PASSWORD");
  return input;
}

export function validateClientId(input: string) {
  const clientId = input.trim();
  if (clientId.length < 16 || clientId.length > 128) throw new Error("INVALID_SIGNIN_CLIENT");
  return clientId;
}

/** Registration also refuses passwords that merely restate the email. */
export function assertPasswordIsNotEmail(email: string, password: string) {
  if (normalizeCustomerEmail(password) === normalizeCustomerEmail(email)) {
    throw new Error("WEAK_PASSWORD");
  }
}
