import { useCallback, useRef } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import type { HistoryState } from "@tanstack/react-router";
import type { Id } from "@convex/_generated/dataModel";
import { APP_PATHS } from "@/lib/app-routes";
import {
  customerWorkspaceSearch, projectWorkspaceSearch, resetWorkspaceFilters, staffWorkspaceSearch,
  type ListView, type WorkspaceSearch, type WorkspaceView,
} from "@/app/workspace-search";

export type { ListView } from "@/app/workspace-search";

declare module "@tanstack/react-router" {
  interface HistoryState {
    workspaceFocusOrigin?: ListView;
    workspaceTicketFromList?: string;
    workspaceStaffQueryId?: string;
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
  // History retains only a key. The mounted staff workspace owns the query text,
  // so reload, sign-out or a different principal cannot recover private searches.
  const privateSearches = useRef(new Map<string, { project: string; query: string }>());
  const readPrivateQuery = (project: string | undefined, id: string | undefined) => {
    const saved = id ? privateSearches.current.get(id) : undefined;
    return saved?.project === project ? saved?.query ?? "" : "";
  };
  const query = search.q ?? (role === "staff" ? readPrivateQuery(search.project, location.state.workspaceStaffQueryId) : "");
  // Staff without an explicit view start on the Board; a URL view always wins.
  // Preserve a nonempty invalid address long enough for the Project chooser to
  // explain its fallback. Only validated Projects can select a backend scope.
  const requestedProject = search.project ?? new URLSearchParams(location.searchStr).get("project")?.trim().slice(0, 64);
  const view = search.view ?? (role === "staff" ? "board" : "queue");
  const listView: ListView = view === "focus" ? location.state.workspaceFocusOrigin ?? "queue" : view;
  const ticket = search.ticket ?? null;
  const defaultFilter = role === "staff" && listView === "board" ? "all" : "active";
  const filter = search.filter ?? (search.archived ? "archive" : defaultFilter);

  const update = useCallback((change: (search: WorkspaceSearch) => WorkspaceSearch, options?: {
    replace?: boolean;
    focusOrigin?: ListView;
    openedFromList?: boolean;
    privateQuery?: string;
  }) => {
    const current = router.state.location;
    const to = role === "customer" ? APP_PATHS.customerHome :
      current.pathname === APP_PATHS.staffLineSettings ? APP_PATHS.staffLineSettings :
      current.pathname === APP_PATHS.staffT3Settings ? APP_PATHS.staffT3Settings : APP_PATHS.staffHome;
    const previous = workspaceSearch(role, current.search);
    const next = change(previous);
    if (next === previous && options?.privateQuery === undefined) return;
    let privateQueryId = role === "staff" && previous.project === next.project ? current.state.workspaceStaffQueryId : undefined;
    if (role === "staff" && options?.privateQuery !== undefined) {
      privateQueryId = undefined;
      if (next.project && options.privateQuery) {
        privateQueryId = crypto.randomUUID();
        privateSearches.current.set(privateQueryId, { project: next.project, query: options.privateQuery });
      }
    }
    const state = (previous: HistoryState) => ({
      ...previous,
      workspaceStaffQueryId: privateQueryId,
      workspaceFocusOrigin: next.view === "focus" ? options?.focusOrigin ?? previous.workspaceFocusOrigin : undefined,
      workspaceTicketFromList: next.ticket ? options?.openedFromList ? to :
        options?.replace ? previous.workspaceTicketFromList : undefined : undefined,
    });
    return router.navigate({ to, search: to === APP_PATHS.staffLineSettings && previous.project === next.project
      ? { ...next, bot: current.search.bot } : next, state, replace: options?.replace, resetScroll: false });
  }, [role, router]);

  const selectProject = useCallback((key: string, replace: boolean, nextView?: ListView) => {
    update(search => {
      if (replace && !search.project && !new URLSearchParams(router.state.location.searchStr).get("project")?.trim()) {
        if (role === "staff" && search.q) return projectWorkspaceSearch(search, key, nextView);
        return { ...search, project: key };
      }
      return projectWorkspaceSearch(search, key, nextView);
    }, { replace });
  }, [role, router, update]);

  const setQuery = useCallback((next: string, fromHistoryKey?: string) => {
    if (fromHistoryKey && fromHistoryKey !== router.history.location.state.__TSR_key) return;
    if (role === "staff") return update(search => ({
      ...search, ...closedTicket, q: undefined, lane: undefined,
    }), { replace: true, privateQuery: next });
    return update(search => search.q === (next || undefined) ? search : {
      ...search, ...closedTicket, q: next || undefined, lane: undefined,
    }, { replace: true });
  }, [role, router, update]);

  const withQuery = (value: string, action: () => void, makePrivate = false) => {
    if (value === query && !(makePrivate && search.q)) {
      action();
      return;
    }
    const { pathname, state } = router.history.location;
    const project = search.project;
    // Commit pending input before a control pushes its destination. Keep the
    // current Ticket so assignment, lane and selection can decide how to handle it.
    const commit = role === "staff"
      ? update(search => ({ ...search, q: undefined, lane: undefined }), { replace: true, privateQuery: value })
      : update(search => ({ ...search, q: value || undefined, lane: undefined }), { replace: true });
    if (!commit) {
      action();
      return;
    }
    void commit.then(() => {
      const current = router.history.location;
      const currentSearch = new URLSearchParams(current.search);
      if (current.pathname === pathname && current.state.__TSR_index === state.__TSR_index &&
          (currentSearch.get("project") ?? undefined) === project &&
          (role === "staff" ? readPrivateQuery(project, current.state.workspaceStaffQueryId) : (currentSearch.get("q") ?? "")) === value) action();
    });
  };

  return {
    withQuery, locationKey: location.state.__TSR_key, project: requestedProject, selectProject, view, listView, filter, query, ticket,
    section: ticket ? search.section ?? null : null,
    assignment: search.assignment, lane: search.lane, health: search.panel === "health",
    setHealth: (open: boolean) => update(search => ({ ...search, panel: open ? "health" : undefined }), { replace: !open }),
    setView: (next: WorkspaceView) => update(search => ({ ...search, ...closedTicket, view: next, lane: undefined })),
    setFilter: (next: string | undefined, clearQuery = false) => update(search => workspaceSearch(role, {
      ...search, ...closedTicket, archived: undefined, filter: next,
      ...(clearQuery ? { q: undefined } : {}),
    }), role === "staff" && clearQuery ? { privateQuery: "" } : undefined),
    setQuery,
    defaultFilter,
    resetFilters: () => update(search => resetWorkspaceFilters(search, defaultFilter)),
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
