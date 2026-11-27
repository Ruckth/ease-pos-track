import type { ReactNode } from "react";
import { Archive, Columns3, FolderPlus, HeartPulse, List, LogOut, MoreHorizontal, Plug, Route, Table2, Tickets, Users, UserCog } from "lucide-react";
import { LanguageMenuGroup } from "@/components/language-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem,
  DropdownMenuSeparator, DropdownMenuTrigger, useMenuAction,
} from "@/components/ui/dropdown-menu";
import { ProjectSwitcher } from "@/components/project-controls";
import { ProductWordmark } from "@/components/product-wordmark";
import { Button } from "@/components/ui/button";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useRoutingCopy } from "@/features/routing/routing-copy";
import { useI18n } from "@/lib/i18n";
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
      className={cn("min-h-10 gap-1.5 rounded-md px-2.5 text-muted-foreground md:min-h-8", value === view && "bg-primary/15 text-primary shadow-sm hover:bg-primary/15")}>
      <Icon aria-hidden />{label}
    </Button>)}
  </div>;
}

type StaffNavigationProps = {
  inbox: ReactNode;
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

export function StaffWorkspaceNavigation({ inbox, projects, current, archived, hideOnPhone, legacyToolsEnabled, lineEnabled, t3Available, onArchive, onSelectProject, onTool, onLogout, owner, signedInAs }: StaffNavigationProps) {
  const { t } = useI18n();
  const { copy: routingCopy } = useRoutingCopy();
  const copy = useExplorerCopy();
  const menu = useMenuAction();
  const openTool = (tool: ProjectTool) => menu.run(() => onTool(tool));
  const pageButtons = [ { archived: false, label: copy.results, Icon: Tickets }, { archived: true, label: t("archive"), Icon: Archive } ];
  return <header className={cn("aurora-toolbar relative z-30 min-w-0",
    hideOnPhone && "hidden lg:block")}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 sm:px-4 sm:gap-x-4">
      <ProductWordmark compact={Boolean(current)} />
      {projects && current && <div className="min-w-0 max-w-full flex-1 xl:flex-none">
        <ProjectSwitcher compact projects={projects} current={current} onSelect={onSelectProject} onCreate={owner && legacyToolsEnabled ? () => onTool("project") : undefined} />
      </div>}
      {current && <nav aria-label={t("project")} className="ml-auto hidden gap-1 xl:flex">{pageButtons.map(({ archived: isArchive, Icon, label }) => <Button type="button" key={label} variant="ghost"
        aria-current={archived === isArchive ? "page" : undefined}
        className={cn("h-auto min-h-11 justify-start", archived === isArchive && "bg-primary/15 font-semibold text-primary hover:bg-primary/15 hover:text-primary")}
        onClick={() => onArchive(isArchive)}><Icon aria-hidden />{label}</Button>)}</nav>}
      <div className="ml-auto flex shrink-0 items-center gap-1.5 xl:ml-0">
        {inbox}
        <DropdownMenu {...menu.root}>
          <DropdownMenuTrigger ref={menu.triggerRef} render={<Button type="button" variant="ghost" className="min-h-11 min-w-11 gap-2 px-2 xl:px-3" />}
            aria-label={t("queueMore")} title={t("queueMore")}>
            <MoreHorizontal aria-hidden className="!size-5" /><span className="hidden sm:inline">{t("queueMore")}</span>
          </DropdownMenuTrigger>
          {/* Kept mounted so sign-out stays wired while a modal owns pointer input. */}
          <DropdownMenuContent keepMounted align="end" className="w-64">
            {current && <DropdownMenuGroup className="xl:hidden">
              <DropdownMenuRadioGroup value={archived ? "archive" : "results"} onValueChange={value => menu.run(() => onArchive(value === "archive"))}>
                {pageButtons.map(({ archived: isArchive, Icon, label }) => <DropdownMenuRadioItem key={label} value={isArchive ? "archive" : "results"} closeOnClick>
                  <Icon aria-hidden />{label}
                </DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </DropdownMenuGroup>}
            <p className="truncate px-2.5 py-1.5 text-xs text-muted-foreground" title={signedInAs}>{signedInAs}</p>
            {owner && legacyToolsEnabled && <DropdownMenuItem onClick={() => openTool("project")}><FolderPlus aria-hidden />{t("newProject")}</DropdownMenuItem>}
            {owner && <DropdownMenuItem onClick={() => openTool("team")}><UserCog aria-hidden />{t("teamTitle")}</DropdownMenuItem>}
            {current && lineEnabled && <DropdownMenuItem onClick={() => openTool("line")}><Plug aria-hidden />LINE</DropdownMenuItem>}
            {current && <DropdownMenuItem onClick={() => openTool("members")}><Users aria-hidden />{t("projectMembers")}</DropdownMenuItem>}
            {legacyToolsEnabled && <DropdownMenuItem onClick={() => openTool("health")}><HeartPulse aria-hidden />{t("healthTitle")}</DropdownMenuItem>}
            {current && <DropdownMenuItem onClick={() => openTool("routing")}><Route aria-hidden />{routingCopy.routing}</DropdownMenuItem>}
            {t3Available && <DropdownMenuItem onClick={() => openTool("t3")}><Plug aria-hidden />{t("connectT3")}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <LanguageMenuGroup />
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => menu.run(() => { void onLogout(); })}><LogOut aria-hidden />{t("signOut")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  </header>;
}
