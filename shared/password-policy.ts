export const PASSWORD_MIN_CODE_POINTS = 15;
export const PASSWORD_MAX_CODE_POINTS = 100;

export type PasswordProblem =
  | "PASSWORD_TOO_SHORT" | "PASSWORD_TOO_LONG" | "PASSWORD_HAS_SURROUNDING_WHITESPACE";

/**
 * One policy for signup, change and recovery: NFC first, then 15–100 code
 * points and no surrounding Unicode whitespace. The pinned password component
 * adds its common-password check and hashes the same NFC value.
 */
export function checkNewPassword(value: string): { password: string } | { problem: PasswordProblem } {
  const password = value.normalize("NFC");
  const length = [...password].length;
  if (length < PASSWORD_MIN_CODE_POINTS) return { problem: "PASSWORD_TOO_SHORT" };
  if (length > PASSWORD_MAX_CODE_POINTS) return { problem: "PASSWORD_TOO_LONG" };
  if (/^\s|\s$/u.test(password)) return { problem: "PASSWORD_HAS_SURROUNDING_WHITESPACE" };
  return { password };
}
