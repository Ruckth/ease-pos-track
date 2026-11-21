import { z } from "zod";

export const MAX_WORKSPACE_QUERY_LENGTH = 200;
export const DEFAULT_STAFF_LANE = "new";
export type CustomerTicketFilter = "all" | "active" | "waiting" | "done";

const commonSearch = {
  project: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,9}$/).optional().catch(undefined),
  // Convex validates the actual Ticket ID during the read.
  ticket: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional().catch(undefined),
};

const staffSearchSchema = z.object({
  ...commonSearch,
  q: z.string().min(1).max(MAX_WORKSPACE_QUERY_LENGTH).optional().catch(undefined),
  archived: z.union([z.literal("true"), z.literal(true)]).transform(() => true as const).optional().catch(undefined),
  lane: z.enum(["acknowledged", "in_progress", "waiting", "done"]).optional().catch(undefined),
  panel: z.literal("health").optional().catch(undefined),
});
const customerSearchSchema = z.object({
  ...commonSearch,
  filter: z.enum(["active", "waiting", "done"]).optional().catch(undefined),
});

export function staffWorkspaceSearch(search: Record<string, unknown>) {
  return staffSearchSchema.parse(search);
}

export function customerWorkspaceSearch(search: Record<string, unknown>) {
  return customerSearchSchema.parse(search);
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
