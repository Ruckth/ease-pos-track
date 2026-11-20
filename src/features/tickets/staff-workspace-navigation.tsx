import { useWorkspaceMenu } from "./use-workspace-menu";
import { Archive, Columns3, FolderPlus, HeartPulse, List, LogOut, MoreHorizontal, Plug, Route, Table2, Tickets, Users, UserCog } from "lucide-react";
import { LanguageSelector } from "@/components/auth-screens";
import { ProjectSwitcher } from "@/components/project-controls";
import { ProductWordmark } from "@/components/product-wordmark";
import { Button } from "@/components/ui/button";
import { useExplorerCopy } from "@/lib/explorer-copy";
import { useRoutingCopy } from "@/features/routing/routing-copy";
import { useI18n } from "@/lib/i18n";
import type { ProjectSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { ListView } from "./use-workspace-navigation";

export type ProjectTool = "project" | "members" | "health" | "team" | "t3" | "routing";

export function StaffViewSwitcher({ view, archived, onSelect }: { view: ListView; archived: boolean; onSelect: (view: ListView) => void }) {
  const { t } = useI18n();
  const copy = useExplorerCopy();
  const options = [
    { value: "queue", label: t("queueLabel"), Icon: List },
    { value: "board", label: copy.board, Icon: Columns3 },
    { value: "table", label: copy.table, Icon: Table2 },
  ] as const;
  return <div id="staff-ticket-layout" role="group" aria-label={copy.view}
    className="inline-flex max-w-full rounded-lg border bg-muted/45 p-0.5">
    {options.filter(option => !archived || option.value !== "board").map(({ value, label, Icon }) => <Button type="button" key={value} size="sm" variant="ghost"
      aria-pressed={value === view} onClick={() => onSelect(value)}
      className={cn("min-h-11 gap-1.5 px-2.5 sm:px-3", value === view && "bg-background text-primary shadow-sm hover:bg-background")}>
      <Icon aria-hidden />{label}
    </Button>)}
  </div>;
}

type StaffNavigationProps = {
  projects?: ProjectSummary[];
  current?: ProjectSummary | null;
  archived: boolean;
  legacyToolsEnabled: boolean;
  hideOnPhone: boolean;
  t3Available: boolean;
  routingAvailable?: boolean;
  onArchive: (value: boolean) => void;
  onSelectProject: (key: string) => void;
  onTool: (tool: ProjectTool) => void;
  onLogout: () => Promise<void>;
  /** Owners administer Projects and the team; Staff work Tickets. */
  owner: boolean;
  signedInAs: string;
};

export function StaffWorkspaceNavigation({ projects, current, archived, hideOnPhone, legacyToolsEnabled, t3Available, routingAvailable, onArchive, onSelectProject, onTool, onLogout, owner, signedInAs }: StaffNavigationProps) {
  const { t, language, setLanguage } = useI18n();
  const { copy: routingCopy } = useRoutingCopy();
  const copy = useExplorerCopy();
  const { props: menuProps, close: closeMenu } = useWorkspaceMenu();
  const openTool = (tool: ProjectTool) => { closeMenu(); onTool(tool); };
  const pageButtons = [ { archived: false, label: copy.results, Icon: Tickets }, { archived: true, label: t("archive"), Icon: Archive } ];
  function destinations(desktop: boolean) {
    return pageButtons.map(({ archived: isArchive, Icon, label }) => <Button type="button" key={label} variant="ghost"
      aria-current={archived === isArchive ? "page" : undefined}
      className={cn("h-auto min-h-11 justify-start", desktop ? "hidden xl:flex" : "flex xl:hidden",
        archived === isArchive && "bg-primary/10 font-semibold text-primary")}
      onClick={() => { closeMenu(); onArchive(isArchive); }}><Icon aria-hidden />{label}</Button>);
  }
  return <aside className={cn("z-30 min-w-0 border-b bg-card xl:sticky xl:top-0 xl:h-dvh xl:self-start xl:border-b-0 xl:border-r",
    hideOnPhone && "hidden lg:block")}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 sm:px-5 xl:h-full xl:flex-col xl:items-stretch xl:gap-5 xl:px-4 xl:py-6">
      <ProductWordmark />
      {projects && current && <div className="order-last min-w-0 max-w-full basis-full min-[480px]:order-none min-[480px]:basis-auto min-[480px]:flex-1 xl:flex-none xl:border-y xl:py-5">
        <span className="mb-1 hidden text-xs font-medium text-muted-foreground xl:block">{t("project")}</span>
        <ProjectSwitcher projects={projects} current={current} onSelect={onSelectProject} onCreate={owner && legacyToolsEnabled ? () => openTool("project") : undefined} />
      </div>}
      {current && <nav aria-label={t("project")} className="hidden gap-1 xl:grid">{destinations(true)}</nav>}
      <details {...menuProps} className="group relative ml-auto xl:ml-0 xl:mt-auto">
        <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center gap-2 rounded-lg text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring xl:justify-start xl:px-3"
          aria-label={t("queueMore")} title={t("queueMore")}><MoreHorizontal aria-hidden className="size-5"/><span className="hidden sm:inline">{t("queueMore")}</span></summary>
        <div className="absolute right-0 z-40 mt-1 grid max-h-[calc(100dvh-6rem)] w-60 max-w-[calc(100vw-1.5rem)] gap-1 overflow-y-auto rounded-xl border bg-card p-2 shadow-lg xl:bottom-full xl:left-0 xl:mb-2">
          {current && destinations(false)}
          <p className="truncate px-2 pb-1 text-xs text-muted-foreground">{signedInAs}</p>
          {owner && legacyToolsEnabled && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("project")}><FolderPlus aria-hidden />{t("newProject")}</Button>}
          {owner && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("team")}><UserCog aria-hidden />{t("teamTitle")}</Button>}
          {current && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("members")}><Users aria-hidden />{t("projectMembers")}</Button>}
          {legacyToolsEnabled && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("health")}><HeartPulse aria-hidden />{t("healthTitle")}</Button>}
          {current && routingAvailable && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("routing")}>
            <Route aria-hidden />{routingCopy.routing}
          </Button>}
          {t3Available && <Button variant="ghost" className="min-h-11 justify-start" onClick={() => openTool("t3")}><Plug aria-hidden />{t("connectT3")}</Button>}
          <div className="flex items-center justify-between gap-2 border-t px-2 pt-2 text-sm text-muted-foreground"><span>{t("language")}</span><LanguageSelector language={language} onChange={setLanguage} /></div>
          <Button variant="ghost" className="min-h-11 justify-start" onClick={() => void onLogout()}><LogOut aria-hidden />{t("signOut")}</Button>
        </div>
      </details>
    </div>
  </aside>;
}
