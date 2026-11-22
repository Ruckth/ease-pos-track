import { useCallback } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { HistoryState } from "@tanstack/react-router";
import type { Id } from "@convex/_generated/dataModel";
import { APP_PATHS } from "@/lib/app-routes";
import {
  customerWorkspaceSearch, projectWorkspaceSearch, staffWorkspaceSearch,
  type ListView, type WorkspaceSearch, type WorkspaceView,
} from "@/app/workspace-search";

export type { ListView } from "@/app/workspace-search";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workspaceFocusOrigin?: ListView;
    workspaceTicketFromList?: string;
  }
}

const closedTicket = { ticket: undefined, section: undefined };

function workspaceSearch(role: "staff" | "customer", search: Record<string, unknown>): WorkspaceSearch {
  return role === "staff" ? staffWorkspaceSearch(search) : customerWorkspaceSearch(search);
}

export function useWorkspaceNavigation(role: "staff" | "customer") {
  const router = useRouter();
  const location = useRouterState({ select: state => state.location });
  const search = workspaceSearch(role, location.search);
  // Staff without an explicit view start on the Board; a URL view always wins.
  const view = search.view ?? (role === "staff" ? "board" : "queue");
  const listView: ListView = view === "focus" ? location.state.workspaceFocusOrigin ?? "queue" : view;
  const ticket = search.ticket ?? null;
  const defaultFilter = role === "staff" && listView === "board" ? "all" : "active";
  const filter = search.filter ?? (search.archived ? "archive" : defaultFilter);

  const update = useCallback((change: (search: WorkspaceSearch) => WorkspaceSearch, options?: {
    replace?: boolean;
    focusOrigin?: ListView;
    openedFromList?: boolean;
  }) => {
    const current = router.state.location;
    const to = role === "customer" ? APP_PATHS.customerHome :
      current.pathname === APP_PATHS.staffT3Settings ? APP_PATHS.staffT3Settings : APP_PATHS.staffHome;
    const previous = workspaceSearch(role, current.search);
    const next = change(previous);
    if (next === previous) return;
    const state = (previous: HistoryState) => ({
      ...previous,
      workspaceFocusOrigin: next.view === "focus" ? options?.focusOrigin ?? previous.workspaceFocusOrigin : undefined,
      workspaceTicketFromList: next.ticket ? options?.openedFromList ? to :
        options?.replace ? previous.workspaceTicketFromList : undefined : undefined,
    });
    return router.navigate({ to, search: next, state, replace: options?.replace, resetScroll: false });
  }, [role, router]);

  const selectProject = useCallback((key: string, replace: boolean, nextView?: ListView) => {
    update(search => {
      if (replace && !search.project) return { ...search, project: key };
      return projectWorkspaceSearch(search, key, nextView);
    }, { replace });
  }, [update]);

  const setQuery = useCallback((next: string, fromHistoryKey?: string) => {
    if (fromHistoryKey && fromHistoryKey !== router.history.location.state.__TSR_key) return;
    update(search => search.q === (next || undefined) ? search : {
      ...search, ...closedTicket, q: next || undefined, lane: undefined,
    }, { replace: true });
  }, [router, update]);

  const withQuery = (value: string, action: () => void) => {
    if (value === (search.q ?? "")) {
      action();
      return;
    }
    const { pathname, state } = router.history.location;
    const project = search.project;
    // Replace the current result URL before a control pushes its destination.
    // Retain any open Ticket so assignment, lane and selection can decide what to do with it.
    const commit = update(search => search.q === (value || undefined) ? search : {
      ...search, q: value || undefined, lane: undefined,
    }, { replace: true });
    if (!commit) {
      action();
      return;
    }
    void commit.then(() => {
      const current = router.history.location;
      const currentSearch = new URLSearchParams(current.search);
      if (current.pathname === pathname && current.state.__TSR_index === state.__TSR_index &&
          (currentSearch.get("project") ?? undefined) === project && (currentSearch.get("q") ?? "") === value) action();
    });
  };

  return {
    withQuery, locationKey: location.state.__TSR_key, project: search.project, selectProject, view, listView, filter, query: search.q ?? "", ticket,
    section: ticket ? search.section ?? null : null,
    assignment: search.assignment, lane: search.lane, health: search.panel === "health",
    setHealth: (open: boolean) => update(search => ({ ...search, panel: open ? "health" : undefined }), { replace: !open }),
    setView: (next: WorkspaceView) => update(search => ({ ...search, ...closedTicket, view: next, lane: undefined })),
    setFilter: (next: string | undefined, clearQuery = false) => update(search => workspaceSearch(role, {
      ...search, ...closedTicket, archived: undefined, filter: next,
      ...(clearQuery ? { q: undefined } : {}),
    })),
    setQuery,
    // Assignment narrows the list while allowing staff to keep working on the open Ticket.
    setAssignment: (next: WorkspaceSearch["assignment"]) => update(search => ({ ...search, assignment: next })),
    setLane: (next: NonNullable<WorkspaceSearch["lane"]>) => update(search => ({ ...search, lane: next }), { replace: true }),
    enterFocus: () => update(search => ({ ...search, view: "focus" }), { replace: true, focusOrigin: listView }),
    leaveFocus: () => update(search => ({ ...search, view: listView }), { replace: true }),
    openTicket: (id: Id<"tickets">, section?: "media", newProject?: { key: string; view?: ListView }) =>
      update(search => ({
        ...(newProject ? projectWorkspaceSearch(search, newProject.key, newProject.view) : search), ticket: id, section,
      }), { replace: Boolean(ticket && !newProject), openedFromList: !ticket && !newProject }),
    changeTicket: (id: Id<"tickets">) => update(search => ({ ...search, ticket: id, section: undefined }), { replace: true }),
    closeTicket: () => {
      if (location.state.workspaceTicketFromList === location.pathname) router.history.back();
      else update(search => ({ ...search, ...closedTicket, ...(view === "focus" ? { view: listView } : {}) }), { replace: true });
    },
  };
}
