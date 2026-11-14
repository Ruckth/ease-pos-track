export const LOCAL_RESET_TARGET = "anonymous:anonymous-track-ease-pos";

export function validateDevelopmentTarget(actual, expected) {
  if (!actual || !/^dev:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(actual)
    || /prod|production|live/i.test(actual) || actual !== expected) {
    throw new Error("RESET_TARGET_REFUSED");
  }
  return actual;
}
