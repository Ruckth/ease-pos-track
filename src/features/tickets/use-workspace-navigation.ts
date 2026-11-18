import { useSyncExternalStore } from "react";
import type { Id } from "@convex/_generated/dataModel";

type WorkspaceView = "queue" | "board" | "focus" | "table";
const locationEvent = "ticket-workspace-location";

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify);
  window.addEventListener(locationEvent, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(locationEvent, notify);
  };
}

function update(changes: Record<string, string | null>, replace = false, openedFromList = false) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  const fromList = openedFromList || (replace && url.searchParams.has("ticket") && window.history.state?.ticketFromList);
  window.history[replace ? "replaceState" : "pushState"]({ ticketFromList: Boolean(fromList) }, "", url);
  window.dispatchEvent(new Event(locationEvent));
}

export function useWorkspaceNavigation(role: "staff" | "customer", projectKey: string | null | undefined) {
  const search = useSyncExternalStore(subscribe, () => window.location.search);
  const params = new URLSearchParams(search);
  const requestedView = params.get("view");
  const view: WorkspaceView = role === "staff" && (requestedView === "board" || requestedView === "table" || requestedView === "focus") ? requestedView : "queue";
  const matchesProject = projectKey && (!params.has("project") || params.get("project")?.toUpperCase() === projectKey);
  const id = matchesProject ? params.get("ticket") : null;
  // The detail endpoint normalizes external IDs and checks the Project before reading.
  const ticketId = id ? id as Id<"tickets"> : null;
  const section = ticketId && params.get("section") === "media" ? "media" as const : null;
  const candidate = params.get("filter") ?? "";
  const allowed = role === "customer" ? ["active", "waiting", "done", "all"] :
    ["active", "all", "new", "acknowledged", "in_progress", "waiting", "done", "archive"];
  const filter = allowed.includes(candidate) ? candidate : "active";
  return {
    view, filter, query: params.get("q") ?? "", ticketId, section,
    setView: (next: WorkspaceView) => update({ view: next === "queue" ? null : next, ticket: null, section: null }),
    setFilter: (next: string) => update({ filter: next === "active" ? null : next, ticket: null, section: null }),
    setQuery: (next: string) => update({ q: next, ticket: null, section: null }, true),
    openTicket: (id: Id<"tickets">, section?: "media") => update({ ticket: id, section: section ?? null }, Boolean(ticketId), !ticketId),
    changeTicket: (id: Id<"tickets">) => update({ ticket: id, section: null }, true),
    closeTicket: () => {
      if (window.history.state?.ticketFromList) window.history.back();
      else update({ ticket: null, section: null }, true);
    },
  };
}
