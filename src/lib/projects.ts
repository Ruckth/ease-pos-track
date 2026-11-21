/**
 * The Project to show: the one the URL names, or the first available one when
 * the URL names none, or names one this account cannot use.
 */
export function pickProject<Project extends { key: string }>(projects: Project[], requestedKey: string | null) {
  const key = requestedKey?.trim().toUpperCase();
  return projects.find((project) => project.key === key) ?? projects[0] ?? null;
}
