import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Archive, Columns3, FolderPlus, HeartPulse, List, LogOut, MoreHorizontal, Plug, Route, Search, Settings2, Table2, Tickets, Users, UserCog, X } from "lucide-react";
import { LanguageMenuGroup } from "@/components/language-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger, useMenuAction,
} from "@/components/ui/dropdown-menu";
import { ProjectSwitcher } from "@/components/project-controls";
import { Button } from "@/components/ui/button";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useRoutingCopy } from "@/features/routing/routing-copy";
import { useI18n } from "@/lib/i18n";
import { useMediaQuery } from "@/lib/use-media-query";
import { useStaffCopy } from "@/lib/staff-copy";
import type { ProjectSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ListView } from "./use-workspace-navigation";

export type ProjectTool = "project" | "members" | "health" | "team" | "t3" | "routing" | "line";

export function StaffViewSwitcher({ view, archived, onSelect }: { view: ListView; archived: boolean; onSelect: (view: ListView) => void }) {
  const { t } = useI18n();
  const copy = useExplorerCopy();
  const options = [
    { value: "queue", label: t("queueLabel"), Icon: List },
    { value: "board", label: copy.board, Icon: Columns3 },
    { value: "table", label: copy.table, Icon: Table2 },
  ] as const;
  return <div id="staff-ticket-layout" role="group" aria-label={copy.view}
    className="aurora-control inline-flex max-w-full rounded-lg p-0.5">
    {options.filter(option => !archived || option.value !== "board").map(({ value, label, Icon }) => <Button type="button" key={value} size="sm" variant="ghost"
      aria-pressed={value === view} onClick={() => onSelect(value)}
      data-state={value === view ? "on" : "off"}
      className={cn("min-h-11 min-w-11 gap-1.5 rounded-md px-2.5 text-muted-foreground md:min-h-8 md:min-w-0", value === view && "bg-primary/15 text-primary shadow-sm hover:bg-primary/15")}>
      <Icon aria-hidden /><span className="max-sm:sr-only">{label}</span>
    </Button>)}
  </div>;
}

type StaffNavigationProps = {
  inbox: ReactNode;
  /** The Project search field: inline from 1024px, behind a Search button on phones. */
  search?: ReactNode;
  /** The typed query, kept while the phone search row is closed. */
  searchQuery?: string;
  /** New Ticket or Continue Ticket, kept directly available. */
  newTicket?: ReactNode;
  projects?: ProjectSummary[];
  current?: ProjectSummary | null;
  archived: boolean;
  legacyToolsEnabled: boolean;
  lineEnabled?: boolean;
  hideOnPhone: boolean;
  t3Available: boolean;
  onArchive: (value: boolean) => void;
  onSelectProject: (key: string) => void;
  onTool: (tool: ProjectTool) => void;
  onLogout: () => Promise<void>;
  /** Owners administer Projects and the team; Staff work Tickets. */
  owner: boolean;
  signedInAs: string;
};

/**
 * One compact signed-in bar: Project first, then search, alerts, New Ticket and a grouped menu. No product name.
 * Below 1024px it is a flat 44px row; Project tools join the Project menu, and an open search takes over the
 * same row until it is closed. Closing keeps the query, and the Search button then names it.
 */
export function StaffWorkspaceNavigation({ inbox, search, searchQuery = "", newTicket, projects, current, archived, hideOnPhone, legacyToolsEnabled, lineEnabled, t3Available, onArchive, onSelectProject, onTool, onLogout, owner, signedInAs }: StaffNavigationProps) {
  const { t } = useI18n();
  const s = useStaffCopy();
  const { copy: routingCopy } = useRoutingCopy();
  const copy = useExplorerCopy();
  const menu = useMenuAction();
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [phoneSearch, setPhoneSearch] = useState(false);
  const searchRow = useId();
  const searchRegion = useRef<HTMLDivElement>(null);
  const searchToggle = useRef<HTMLButtonElement>(null);
  const searchActive = searchQuery.trim().length > 0;
  const showPhoneSearch = !desktop && Boolean(search) && phoneSearch;
  // A query that arrives from a link, Back or a saved search opens the field with it.
  useEffect(() => { if (searchActive) setPhoneSearch(true); }, [searchActive]);
  const focusTarget = useRef<"input" | "toggle" | null>(null);
  useEffect(() => {
    if (desktop || !focusTarget.current) return;
    const target = focusTarget.current;
    focusTarget.current = null;
    if (target === "input") searchRegion.current?.querySelector("input")?.focus();
    else searchToggle.current?.focus();
  }, [phoneSearch, desktop]);
  const togglePhoneSearch = (open: boolean) => { focusTarget.current = open ? "input" : "toggle"; setPhoneSearch(open); };
  const openTool = (tool: ProjectTool) => menu.run(() => onTool(tool));
  const manage = useMenuAction();
  const manageTool = (tool: ProjectTool) => manage.run(() => onTool(tool));
  const pageButtons = [ { archived: false, label: copy.results, Icon: Tickets }, { archived: true, label: t("archive"), Icon: Archive } ];
  const projectTools = current || (owner && legacyToolsEnabled);
  const adminTools = owner || legacyToolsEnabled || t3Available;
  const searchLabel = searchActive ? s.searchOpenWith(searchQuery.trim()) : s.searchOpen;
  const projectMenuItems = (selectTool: (tool: ProjectTool) => void) => <DropdownMenuGroup>
            <DropdownMenuLabel>{current ? `${s.manageProject} · ${current.key}` : s.manageProject}</DropdownMenuLabel>
            {current && <DropdownMenuItem onClick={() => selectTool("members")}><Users aria-hidden />{t("projectMembers")}</DropdownMenuItem>}
            {current && <DropdownMenuItem onClick={() => selectTool("routing")}><Route aria-hidden />{routingCopy.routing}</DropdownMenuItem>}
            {current && lineEnabled && <DropdownMenuItem onClick={() => selectTool("line")}><Plug aria-hidden />LINE</DropdownMenuItem>}
            {owner && legacyToolsEnabled && <DropdownMenuItem onClick={() => selectTool("project")}><FolderPlus aria-hidden />{t("newProject")}</DropdownMenuItem>}
          </DropdownMenuGroup>;
  return <header className={cn("aurora-toolbar relative z-30 min-w-0",
    // Phones get a flat, full-bleed bar; the parent's 12/20px gutter is cancelled.
    "max-lg:-mx-3 max-lg:rounded-none max-lg:border-x-0 max-lg:border-t-0 max-lg:shadow-none sm:max-lg:-mx-5",
    hideOnPhone && "hidden lg:block")}>
    {/* The bar stays mounted under an open search so the inbox, menus and focus return keep their state. */}
    {showPhoneSearch && <div id={searchRow} ref={searchRegion} className="flex min-h-11 min-w-0 items-center gap-1 px-1 sm:px-3"
      onKeyDown={event => {
        // Escape closes the row unless an open menu inside it (saved searches) takes the key first.
        if (event.key !== "Escape" || event.defaultPrevented || (event.target as HTMLElement).closest('[role="menu"]')) return;
        event.preventDefault();
        togglePhoneSearch(false);
      }}>
      <div className="min-w-0 flex-1">{search}</div>
      <Button type="button" variant="ghost" size="icon" className="size-11 shrink-0" aria-label={s.searchClose} title={s.searchClose}
        aria-expanded aria-controls={searchRow} onClick={() => togglePhoneSearch(false)}>
        <X aria-hidden className="!size-5" />
      </Button>
    </div>}
    <div className={cn("flex min-h-11 min-w-0 items-center gap-1 px-1 sm:px-3 lg:min-h-[52px] lg:flex-wrap lg:gap-1.5 lg:py-1", showPhoneSearch && "hidden")}>
      {projects && current && <div className="min-w-[66px] flex-1 lg:max-w-xs lg:flex-none">
        <ProjectSwitcher compact projects={projects} current={current} onSelect={onSelectProject}
          onCreate={desktop && owner && legacyToolsEnabled ? () => onTool("project") : undefined}
          tools={desktop ? undefined : run => projectMenuItems(tool => run(() => onTool(tool)))} />
      </div>}
      {projectTools && desktop && <DropdownMenu {...manage.root}>
        <DropdownMenuTrigger ref={manage.triggerRef} render={<Button type="button" variant="ghost" className="min-h-11 min-w-11 shrink-0 gap-1.5 px-2" />}
          aria-label={s.manageProject} title={s.manageProject}>
          <Settings2 aria-hidden className="!size-5" /><span className="hidden xl:inline">{s.manageProject}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {projectMenuItems(manageTool)}
        </DropdownMenuContent>
      </DropdownMenu>}
      {desktop && search && <div className="min-w-0 max-w-xl flex-1">{search}</div>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {!desktop && search && <Button ref={searchToggle} type="button" variant="ghost" size="icon" className="relative size-11"
          aria-label={searchLabel} title={searchLabel} aria-expanded={false} aria-controls={searchRow}
          onClick={() => togglePhoneSearch(true)}>
          <Search aria-hidden className="!size-5" />
          {searchActive && <span aria-hidden className="absolute right-2 top-2 size-2 rounded-full bg-primary ring-2 ring-background" />}
        </Button>}
        {inbox}
        {newTicket}
        <DropdownMenu {...menu.root}>
          <DropdownMenuTrigger ref={menu.triggerRef} render={<Button type="button" variant="ghost" className="min-h-11 min-w-11 gap-2 px-2 xl:px-3" />}
            aria-label={t("queueMore")} title={t("queueMore")}>
            <MoreHorizontal aria-hidden className="!size-5" /><span className="hidden xl:inline">{t("queueMore")}</span>
          </DropdownMenuTrigger>
          {/* Kept mounted so sign-out stays wired while a modal owns pointer input. */}
          <DropdownMenuContent keepMounted align="end" className="w-64">
            {current && <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{s.menuShow}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={archived ? "archive" : "results"} onValueChange={value => menu.run(() => onArchive(value === "archive"))}>
                  {pageButtons.map(({ archived: isArchive, Icon, label }) => <DropdownMenuRadioItem key={label} value={isArchive ? "archive" : "results"} closeOnClick>
                    <Icon aria-hidden />{label}
                  </DropdownMenuRadioItem>)}
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>}
            {/* Without an open Project there is no Project menu, so its tools stay here on phones. */}
            {projectTools && !desktop && !(projects && current) && <>{projectMenuItems(openTool)}<DropdownMenuSeparator /></>}
            {adminTools && <>
              <DropdownMenuGroup>
                <DropdownMenuLabel>{s.menuAdmin}</DropdownMenuLabel>
                {owner && <DropdownMenuItem onClick={() => openTool("team")}><UserCog aria-hidden />{t("teamTitle")}</DropdownMenuItem>}
                {legacyToolsEnabled && <DropdownMenuItem onClick={() => openTool("health")}><HeartPulse aria-hidden />{t("healthTitle")}</DropdownMenuItem>}
                {t3Available && <DropdownMenuItem onClick={() => openTool("t3")}><Plug aria-hidden />{t("connectT3")}</DropdownMenuItem>}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
            </>}
            <LanguageMenuGroup />
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{s.menuAccount}</DropdownMenuLabel>
              <p className="truncate px-2.5 py-1.5 text-xs text-muted-foreground" title={signedInAs}>{signedInAs}</p>
              <DropdownMenuItem onClick={() => menu.run(() => { void onLogout(); })}><LogOut aria-hidden />{t("signOut")}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </header>;
}
