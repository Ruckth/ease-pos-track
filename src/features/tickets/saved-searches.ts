import { MAX_WORKSPACE_QUERY_LENGTH } from "@/app/workspace-search";

export type SavedSearch = { name: string; query: string; archived: boolean };
const PREFIX = "staff-saved-searches:";
const MAX_SAVED = 10;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
const session = (): Store | null => { try { return window.sessionStorage; } catch { return null; } };

/** Saved searches live in this tab's session, per signed-in staff member and Project. */
export function loadSavedSearches(staffId: string, projectId: string, store = session()): SavedSearch[] {
  try {
    const value: unknown = JSON.parse(store?.getItem(`${PREFIX}${staffId}:${projectId}`) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is SavedSearch => typeof item?.name === "string"
      && typeof item.query === "string" && typeof item.archived === "boolean") : [];
  } catch { return []; }
}

export function saveSearch(staffId: string, projectId: string, search: SavedSearch, store = session()): SavedSearch[] {
  const name = search.name.trim().slice(0, 60);
  const query = search.query.trim().slice(0, MAX_WORKSPACE_QUERY_LENGTH);
  if (!name || !query) return loadSavedSearches(staffId, projectId, store);
  const next = [{ name, query, archived: search.archived }, ...loadSavedSearches(staffId, projectId, store).filter(item => item.name !== name)].slice(0, MAX_SAVED);
  try { store?.setItem(`${PREFIX}${staffId}:${projectId}`, JSON.stringify(next)); } catch { /* storage unavailable: keep in memory */ }
  return next;
}

export function removeSavedSearch(staffId: string, projectId: string, name: string, store = session()): SavedSearch[] {
  const next = loadSavedSearches(staffId, projectId, store).filter(item => item.name !== name);
  try { store?.setItem(`${PREFIX}${staffId}:${projectId}`, JSON.stringify(next)); } catch { /* ignore */ }
  return next;
}

/** Sign-out removes every account's saved searches from this tab. */
export function clearSavedSearches(store = session()) {
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    keys.forEach(key => store.removeItem(key));
  } catch { /* ignore */ }
}
