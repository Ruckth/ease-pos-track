import { z } from "zod";

export const MAX_WORKSPACE_QUERY_LENGTH = 200;
export const DEFAULT_STAFF_LANE = "new";
export const workspaceStatuses = ["new", "acknowledged", "in_progress", "waiting", "done"] as const;
const listViews = ["queue", "board", "table"] as const;
export type ListView = typeof listViews[number];
export type WorkspaceView = ListView | "focus";

const commonSearch = {
  project: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional().catch(undefined),
  // The scoped Convex read resolves external references and enforces access.
  ticket: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional().catch(undefined),
  q: z.string().min(1).max(MAX_WORKSPACE_QUERY_LENGTH).optional().catch(undefined),
  section: z.literal("media").optional().catch(undefined),
};

const staffSearchSchema = z.object({
  ...commonSearch,
  view: z.enum([...listViews, "focus"]).optional().catch(undefined),
  filter: z.enum(["active", "all", ...workspaceStatuses, "archive"]).optional().catch(undefined),
  assignment: z.enum(["mine", "unassigned"]).optional().catch(undefined),
  archived: z.union([z.literal("true"), z.literal(true)]).transform(() => true as const).optional().catch(undefined),
  lane: z.enum(workspaceStatuses).optional().catch(undefined),
  panel: z.literal("health").optional().catch(undefined),
});
const customerSearchSchema = z.object({
  ...commonSearch,
  filter: z.enum(["all", "active", "waiting", "done"]).optional().catch(undefined),
});

export type WorkspaceSearch = z.output<typeof staffSearchSchema>;

export function staffWorkspaceSearch(search: Record<string, unknown>) {
  return staffSearchSchema.parse(search);
}

export function customerWorkspaceSearch(search: Record<string, unknown>) {
  return customerSearchSchema.parse(search);
}

/** A different Project starts with its own view and a fresh result set. */
export function projectWorkspaceSearch(search: WorkspaceSearch, project: string, view?: ListView): WorkspaceSearch {
  return {
    project,
    view: view ?? (search.view === "focus" ? undefined : search.view),
    panel: search.panel,
  };
}

/**
 * Clear filters: the view's default status and every assignment, in one history entry.
 * Search, view and lane stay; Archive is a page rather than a filter, so it stays too.
 * A status change closes the open Ticket, as choosing a status does.
 */
export function resetWorkspaceFilters(search: WorkspaceSearch, defaultFilter: "active" | "all"): WorkspaceSearch {
  const current = search.filter ?? (search.archived ? "archive" : defaultFilter);
  if (current === "archive" || (!search.filter && !search.assignment)) return search;
  const ticket = current === defaultFilter ? {} : { ticket: undefined, section: undefined };
  return { ...search, ...ticket, filter: undefined, assignment: undefined };
}

// Search parameters are scalars. Keep text such as "null", "007" and quoted
// phrases intact instead of interpreting them as JSON values.
export function parseWorkspaceSearch(search: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(search));
}

export function stringifyWorkspaceSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string" || typeof value === "boolean") params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}
