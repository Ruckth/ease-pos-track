import { useSyncExternalStore } from "react";
import type { Id } from "@convex/_generated/dataModel";

export type ListView = "queue" | "board" | "table";
type WorkspaceView = ListView | "focus";
const locationEvent = "ticket-workspace-location";

type NavigationSnapshot = { search: string; focusOrigin: ListView; ticketFromList: boolean };
let cachedSnapshot: NavigationSnapshot | undefined;

function getSnapshot(): NavigationSnapshot {
  const { search } = window.location;
  const { focusOrigin: origin, ticketFromList: opened } = window.history.state ?? {};
  const focusOrigin = origin === "board" || origin === "table" ? origin : "queue";
  const ticketFromList = opened === true;
  if (!cachedSnapshot || cachedSnapshot.search !== search || cachedSnapshot.focusOrigin !== focusOrigin ||
      cachedSnapshot.ticketFromList !== ticketFromList) cachedSnapshot = { search, focusOrigin, ticketFromList };
  return cachedSnapshot;
}

function subscribe(notify: () => void) {
  window.addEventListener("popstate", notify);
  window.addEventListener(locationEvent, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(locationEvent, notify);
  };
}

function update(changes: Record<string, string | null>, replace = false, openedFromList = false, focusOrigin?: ListView) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(changes)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href === window.location.href) return;
  const fromList = openedFromList || (replace && url.searchParams.has("ticket") && window.history.state?.ticketFromList);
  const fromView = url.searchParams.get("view") === "focus" ? focusOrigin ?? window.history.state?.focusOrigin : undefined;
  window.history[replace ? "replaceState" : "pushState"]({ ticketFromList: Boolean(fromList), focusOrigin: fromView }, "", url);
  window.dispatchEvent(new Event(locationEvent));
}

export function useWorkspaceNavigation(role: "staff" | "customer", projectKey: string | null | undefined) {
  const { search, focusOrigin, ticketFromList } = useSyncExternalStore(subscribe, getSnapshot);
  const params = new URLSearchParams(search);
  const requestedView = params.get("view");
  const defaultView = role === "staff" && !params.has("ticket") ? "board" : "queue";
  const validView = requestedView === "queue" || requestedView === "board" || requestedView === "table" || requestedView === "focus";
  const view: WorkspaceView = role === "staff" && validView ? requestedView : defaultView;
  const matchesProject = projectKey && (!params.has("project") || params.get("project")?.toUpperCase() === projectKey);
  const id = matchesProject ? params.get("ticket") : null;
  // The detail endpoint normalizes external IDs and checks the Project before reading.
  const ticketId = id ? id as Id<"tickets"> : null;
  const section = ticketId && params.get("section") === "media" ? "media" as const : null;
  const candidate = params.get("filter") ?? "";
  const allowed = role === "customer" ? ["active", "waiting", "done", "all"] :
    ["active", "all", "new", "acknowledged", "in_progress", "waiting", "done", "archive"];
  const defaultFilter = view === "board" ? "all" : "active";
  const filter = allowed.includes(candidate) ? candidate : defaultFilter;
  const listView: ListView = view === "focus" ? focusOrigin : view;
  return {
    view, listView, filter, query: params.get("q") ?? "", ticketId, section,
    setView: (next: WorkspaceView) => update({ view: next, filter: filter === "archive" ? "archive" : null, ticket: null, section: null }),
    setFilter: (next?: string) => update({ filter: next === defaultFilter ? null : next ?? null, ticket: null, section: null }),
    setQuery: (next: string) => update({ q: next, ticket: null, section: null }, true),
    enterFocus: () => update({ view: "focus" }, true, false, listView),
    leaveFocus: () => update({ view: listView }, true),
    openTicket: (id: Id<"tickets">, section?: "media") => update({ view: role === "staff" ? new URLSearchParams(window.location.search).get("view") ?? view : null, ticket: id, section: section ?? null }, Boolean(ticketId), !ticketId),
    changeTicket: (id: Id<"tickets">) => update({ ticket: id, section: null }, true),
    closeTicket: () => {
      if (ticketFromList) window.history.back();
      else update({ ticket: null, section: null, ...(view === "focus" ? { view: listView } : {}) }, true);
    },
  };
}
