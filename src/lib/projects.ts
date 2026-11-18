/** The query parameter that keeps the open Project in the URL: `/staff?project=POS`. */
const PROJECT_PARAM = "project";

/**
 * The Project to show: the one the URL names, or the first available one when
 * the URL names none, or names one this account cannot use.
 */
export function pickProject<Project extends { key: string }>(projects: Project[], requestedKey: string | null) {
  const key = requestedKey?.trim().toUpperCase();
  return projects.find((project) => project.key === key) ?? projects[0] ?? null;
}

export function readProjectParam(search: string) {
  return new URLSearchParams(search).get(PROJECT_PARAM);
}

/** The same URL with the project parameter set, other parameters untouched. */
export function withProjectParam(href: string, key: string, clearContext = false) {
  const url = new URL(href);
  if (clearContext) {
    for (const param of ["ticket", "section", "q", "filter"]) url.searchParams.delete(param);
  }
  url.searchParams.set(PROJECT_PARAM, key);
  return `${url.pathname}${url.search}${url.hash}`;
}
