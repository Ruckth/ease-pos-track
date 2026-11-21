import { getRouteApi } from "@tanstack/react-router";
import { DEFAULT_STAFF_LANE, MAX_WORKSPACE_QUERY_LENGTH } from "@/app/workspace-search";
import { StaffHealth } from "@/features/operations/staff-health";
import { LanguageSelector } from "@/components/auth-screens";
import { NewProjectDialog, NoProjects, StaffProjectControls, useCurrentProject } from "@/components/project-controls";
import { TicketExplorer } from "@/components/ticket-explorer";
import { ArchivedTicketDialog } from "@/components/archived-ticket-dialog";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { type Ticket, type TicketStatus } from "@/lib/types";
import type { Id } from "@convex/_generated/dataModel";
import {
  Archive,
  ImagePlus,
  Loader2,
  LogOut,
  Search
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { type TicketSummary } from "../../../shared/ticket-contracts";
import { useProjectTicket, useStaffTickets, useTicketTags } from "./adapter";
import { useComposer } from "./use-composer";
import { useTicketOperations } from "./use-ticket-operations";

import { SubmitTicket } from "./staff-composer";
import { StaffTicketDialog } from "./staff-ticket-dialog";

const staffRoute = getRouteApi("/staff");

export function StaffWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const { language, setLanguage, t } = useI18n();
  const navigate = staffRoute.useNavigate();
  const { project: requestedProject, q, archived, lane, ticket, panel } = staffRoute.useSearch();
  const healthOpen = panel === "health";
  const showArchived = archived === true;
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const navigateProject = useCallback((key: string, replace: boolean) => {
    void navigate({
      search: (current) => ({ ...current, project: key, ticket: replace ? current.ticket : undefined }),
      replace,
    });
  }, [navigate]);
  const { projects, current: project, select: selectProject } = useCurrentProject(token, requestedProject, navigateProject);
  const composer = useComposer(project, onLogout);
  const [search, setSearch] = useState(q ?? "");
  useEffect(() => setSearch(q ?? ""), [q, project?._id]);
  useEffect(() => {
    if (search === (q ?? "")) return;
    const timeout = setTimeout(() => {
      void navigate({ search: (current) => ({ ...current, q: search || undefined }), replace: true, resetScroll: false });
    }, 300);
    return () => clearTimeout(timeout);
  }, [navigate, q, search, project?._id]);
  const query = q?.trim() ?? "";
  const { lanes, items: activeItems, loading, invalidSearch, totals, matches, archive, archiveMatches, archivedItems } = useStaffTickets(token, project?._id, showArchived, query);
  const operations = useTicketOperations(token);
  const tags = useTicketTags(token);

  const selectedId = healthOpen ? undefined : ticket;
  const selected = useProjectTicket(token, selectedId, project === null ? null : project?._id);
  function selectTicket(id: Id<"tickets">) {
    void navigate({ search: (current) => ({ ...current, ticket: id }), resetScroll: false });
  }

  function closeTicket() {
    void navigate({
      search: (current) => current.ticket === ticket ? { ...current, ticket: undefined } : current,
      replace: true, resetScroll: false,
    });
  }

  function setHealthOpen(open: boolean) {
    void navigate({
      search: (current) => ({ ...current, panel: open ? "health" : undefined, ticket: open ? undefined : current.ticket }),
      replace: !open,
      resetScroll: false,
    });
  }

  /** Return the committed version; null removes a rejected operation overlay. */
  async function moveItem(current: TicketSummary | Ticket, status: TicketStatus) {
    try {
      return (await operations.status(current, status)).version;
    } catch (error) {
      toast.error(localizeError(error, t));
      return null;
    }
  }

  async function restoreItem(id: Id<"tickets">) {
    const current = archivedItems.find((item) => item._id === id) ?? selected;
    if (current) await operations.restore(current);
  }

  async function archiveItem(_id: Id<"tickets">) {
    if (!selected) return;
    await operations.archive(selected);
    closeTicket();
  }

  return (
    <main className="min-h-screen">
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">{t("appName")}</h1>
            <p className="text-sm text-muted-foreground">{totals ? t("ticketItems", { count: Object.values(totals).reduce((sum, count) => sum + count, 0) }) : project === null ? t("noProjectsTitle") : t("syncing")}</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:flex-nowrap">
            {projects ? (
              <StaffProjectControls
                token={token}
                projects={projects}
                current={project ?? null}
                onSelect={selectProject}
                onCreate={() => setNewProjectOpen(true)}
              />
            ) : null}
            <div className="relative min-w-48 flex-1 basis-full sm:basis-auto lg:w-72 lg:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder={t("search")} maxLength={MAX_WORKSPACE_QUERY_LENGTH} value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button
              type="button"
              variant="default"
              aria-expanded={composer.open}
              disabled={!project && !composer.owner}
              onClick={composer.show}
            >
              <ImagePlus />
              {composer.hasDraft ? t("resumeTicket") : t("newTicket")}
            </Button>
            <Button variant={showArchived ? "default" : "outline"} onClick={() => void navigate({
              search: (current) => ({ ...current, archived: current.archived ? undefined : true }),
              replace: true, resetScroll: false,
            })}>
              <Archive />
              {showArchived ? t("hideArchive") : t("archive")}
            </Button>
            <Button variant="outline" onClick={() => setHealthOpen(true)}>{t("healthTitle")}</Button>
            <LanguageSelector language={language} onChange={setLanguage} />
            <Button variant="outline" size="icon" onClick={() => void composer.signOut()} aria-label={t("signOut")}>
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6">
        <section className="min-w-0">
          {project === null ? (
            <NoProjects action={<Button type="button" onClick={() => setNewProjectOpen(true)}>{t("newProject")}</Button>} />
          ) : invalidSearch ? (
            <p role="alert" className="text-sm text-destructive">{t("searchLimit")}</p>
          ) : project === undefined ? (
            <div className="grid min-h-72 place-items-center rounded-lg border bg-card">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <TicketExplorer key={project._id} projectId={project._id} token={token}
              items={query ? matches?.matches ?? [] : activeItems} archivedItems={archivedItems}
              tags={tags ?? []} search={query} onSearch={setSearch} showArchived={showArchived}
              totals={totals ?? {}} pages={lanes} archive={archive}
              loading={query ? matches === undefined : loading} searchHasMore={matches?.hasMore} archiveSearchHasMore={archiveMatches?.hasMore}
              visibleLane={lane ?? DEFAULT_STAFF_LANE}
              onLaneChange={(status) => void navigate({
                search: (current) => ({ ...current, lane: status === DEFAULT_STAFF_LANE ? undefined : status }),
                replace: true, resetScroll: false,
              })}
              onSelect={selectTicket} onMove={moveItem}
              onRestore={id => { void restoreItem(id).catch(error => toast.error(localizeError(error, t))); }} />
          )}
        </section>
      </div>

      <Dialog
        open={composer.open}
        initialFocus={() => document.getElementById("title")}
        onOpenChange={composer.setOpen}
        title={t("newTicket")}
        description={composer.project ? `${composer.project.name} (${composer.project.key})` : t("internalBoard")}
      >
        {composer.owner ? <Button type="button" variant="outline" disabled={composer.busy} onClick={composer.discard}>{t("discardDraft")}</Button> : null}
        {composer.project ? <SubmitTicket
          key={composer.project._id}
          token={token}
          draftOwner={composer.owner!}
          active={composer.open}
          onSubmissionComplete={composer.complete}
        /> : null}
      </Dialog>

      <Dialog open={healthOpen} onOpenChange={setHealthOpen} title={t("healthTitle")} description={t("healthDescription")}>
        {healthOpen ? <StaffHealth token={token} /> : null}
      </Dialog>

      <NewProjectDialog token={token} open={newProjectOpen} onOpenChange={setNewProjectOpen} onCreated={selectProject} />

      {selected?.lifecycle === "archived" ? <ArchivedTicketDialog item={selected} onClose={closeTicket} onRestore={async () => { await operations.restore(selected); }} /> : <StaffTicketDialog
        key={project?._id}
        ticket={selected}
        ticketId={selectedId}
        token={token}
        onClose={closeTicket}
        onMove={(_id, status) => { if (selected) void moveItem(selected, status); }}
        onArchive={archiveItem}
      />}
    </main>
  );
}
