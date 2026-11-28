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
  searchActive?: boolean;
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

/** One compact signed-in bar: Project first, then search, alerts, New Ticket and a grouped menu. No product name. */
export function StaffWorkspaceNavigation({ inbox, search, searchActive = false, newTicket, projects, current, archived, hideOnPhone, legacyToolsEnabled, lineEnabled, t3Available, onArchive, onSelectProject, onTool, onLogout, owner, signedInAs }: StaffNavigationProps) {
  const { t } = useI18n();
  const s = useStaffCopy();
  const { copy: routingCopy } = useRoutingCopy();
  const copy = useExplorerCopy();
  const menu = useMenuAction();
  const showProjectMenuButton = useMediaQuery("(min-width: 360px)");
  const desktop = useMediaQuery("(min-width: 1024px)");
  const [phoneSearch, setPhoneSearch] = useState(false);
  const searchRow = useId();
  const searchRegion = useRef<HTMLDivElement>(null);
  const showPhoneSearch = !desktop && Boolean(search) && (phoneSearch || searchActive);
  // An active query keeps its field open, so clearing it leaves focus in place.
  useEffect(() => { if (searchActive) setPhoneSearch(true); }, [searchActive]);
  const focusSearch = useRef(false);
  useEffect(() => {
    if (!phoneSearch || desktop || !focusSearch.current) return;
    focusSearch.current = false;
    searchRegion.current?.querySelector("input")?.focus();
  }, [phoneSearch, desktop]);
  const openTool = (tool: ProjectTool) => menu.run(() => onTool(tool));
  const manage = useMenuAction();
  const manageTool = (tool: ProjectTool) => manage.run(() => onTool(tool));
  const pageButtons = [ { archived: false, label: copy.results, Icon: Tickets }, { archived: true, label: t("archive"), Icon: Archive } ];
  const projectTools = current || (owner && legacyToolsEnabled);
  const adminTools = owner || legacyToolsEnabled || t3Available;
  const projectMenuItems = (selectTool: (tool: ProjectTool) => void) => <DropdownMenuGroup>
            <DropdownMenuLabel>{current ? `${s.manageProject} · ${current.key}` : s.manageProject}</DropdownMenuLabel>
            {current && <DropdownMenuItem onClick={() => selectTool("members")}><Users aria-hidden />{t("projectMembers")}</DropdownMenuItem>}
            {current && <DropdownMenuItem onClick={() => selectTool("routing")}><Route aria-hidden />{routingCopy.routing}</DropdownMenuItem>}
            {current && lineEnabled && <DropdownMenuItem onClick={() => selectTool("line")}><Plug aria-hidden />LINE</DropdownMenuItem>}
            {owner && legacyToolsEnabled && <DropdownMenuItem onClick={() => selectTool("project")}><FolderPlus aria-hidden />{t("newProject")}</DropdownMenuItem>}
          </DropdownMenuGroup>;
  return <header className={cn("aurora-toolbar relative z-30 min-w-0",
    hideOnPhone && "hidden lg:block")}>
    <div className="flex min-h-[52px] min-w-0 flex-wrap items-center gap-1.5 px-2 py-1 sm:px-3">
      {projects && current && <div className="min-w-[66px] flex-1 lg:max-w-xs lg:flex-none">
        <ProjectSwitcher compact projects={projects} current={current} onSelect={onSelectProject} onCreate={owner && legacyToolsEnabled ? () => onTool("project") : undefined} />
      </div>}
      {projectTools && showProjectMenuButton && <DropdownMenu {...manage.root}>
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
        {!desktop && search && !searchActive && <Button type="button" variant="ghost" size="icon" className="size-11"
          aria-label={showPhoneSearch ? s.searchClose : s.searchOpen} title={showPhoneSearch ? s.searchClose : s.searchOpen}
          aria-expanded={showPhoneSearch} aria-controls={searchRow}
          onClick={() => { focusSearch.current = !phoneSearch; setPhoneSearch(!phoneSearch); }}>
          {showPhoneSearch ? <X aria-hidden className="!size-5" /> : <Search aria-hidden className="!size-5" />}
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
            {projectTools && !showProjectMenuButton && <>{projectMenuItems(openTool)}<DropdownMenuSeparator /></>}
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
    {showPhoneSearch && <div id={searchRow} ref={searchRegion} className="px-2 pb-2">{search}</div>}
  </header>;
}
