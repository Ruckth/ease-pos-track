import { useEffect, useState } from "react";
import { Bookmark, Link2, X } from "lucide-react";
import { toast } from "sonner";
import { stringifyWorkspaceSearch } from "@/app/workspace-search";
import { APP_PATHS } from "@/lib/app-routes";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, useMenuAction } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { useStaffCopy } from "@/lib/staff-copy";
import { loadSavedSearches, removeSavedSearch, saveSearch, type SavedSearch } from "./saved-searches";

/** Named searches beside the field; one selection restores the query and archive scope. */
export function SavedSearchMenu({ staffId, projectId, projectKey, query, archived, onRestore }: {
  staffId: string; projectId: string; projectKey: string; query: string; archived: boolean;
  onRestore: (search: SavedSearch) => void;
}) {
  const s = useStaffCopy();
  const menu = useMenuAction();
  const [saved, setSaved] = useState(() => loadSavedSearches(staffId, projectId));
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  useEffect(() => { setSaved(loadSavedSearches(staffId, projectId)); }, [staffId, projectId]);
  const canSave = query.trim().length > 0;
  return <>
    <DropdownMenu {...menu.root}>
      <DropdownMenuTrigger ref={menu.triggerRef} render={<Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" />}
        aria-label={s.savedSearches} title={s.savedSearches}>
        <Bookmark aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{s.savedSearches}</DropdownMenuLabel>
          {saved.length === 0 && <p className="px-2.5 py-1.5 text-sm text-muted-foreground">{s.savedNone}</p>}
          {saved.map(item => <div key={item.name} className="flex items-center gap-1">
            <DropdownMenuItem className="min-w-0 flex-1" onClick={() => menu.run(() => onRestore(item))}>
              <span className="min-w-0 truncate">{item.name}</span>
              <span className="ms-auto shrink-0 truncate text-xs text-muted-foreground">{item.archived ? `${s.savedArchive} · ` : ""}{item.query}</span>
            </DropdownMenuItem>
            <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0" aria-label={s.removeSaved(item.name)}
              onClick={() => setSaved(removeSavedSearch(staffId, projectId, item.name))}><X aria-hidden /></Button>
          </div>)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canSave} onClick={() => menu.run(() => { setName(query.trim().slice(0, 60)); setNaming(true); })}>{s.saveSearch}</DropdownMenuItem>
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{s.savedHint}</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={!canSave} onClick={() => menu.run(() => {
          // Sharing is explicit: the link carries the Project, query and archive scope; access is checked when opened.
          const link = `${window.location.origin}${APP_PATHS.staffHome}${stringifyWorkspaceSearch({ project: projectKey, q: query.trim(), ...(archived ? { filter: "archive" } : {}) })}`;
          void navigator.clipboard.writeText(link).then(() => toast.success(s.searchLinkCopied), () => toast.error(link));
        })}><Link2 aria-hidden />{s.copySearchLink}</DropdownMenuItem>
        <p className="px-2.5 py-1.5 text-xs text-muted-foreground">{s.searchLinkWarning}</p>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={naming} onOpenChange={setNaming} title={s.saveSearchTitle} description={query}>
      <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        setSaved(saveSearch(staffId, projectId, { name, query, archived }));
        setNaming(false);
      }}>
        <label className="block space-y-1.5 text-sm font-medium">{s.saveName}
          <Input autoFocus required maxLength={60} value={name} onChange={event => setName(event.target.value)} />
        </label>
        <div className="flex justify-end"><Button type="submit" disabled={!name.trim()}>{s.saveConfirm}</Button></div>
      </form>
    </Dialog>
  </>;
}
