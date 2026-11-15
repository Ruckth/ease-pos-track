import { StaffHealth } from "@/features/operations/staff-health";
import { LanguageSelector } from "@/components/auth-screens";
import { NewProjectDialog, NoProjects, StaffProjectControls, useCurrentProject } from "@/components/project-controls";
import { TicketExplorer } from "@/components/ticket-explorer";
import { ArchivedTicketDialog } from "@/components/archived-ticket-dialog";
import { useTicketTags } from "./adapter";
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
import { useState } from "react";
import { toast, Toaster } from "sonner";
import { type TicketSummary } from "../../../shared/ticket-contracts";
import { useSelectedTicket, useStaffTickets } from "./adapter";
import { useComposer } from "./use-composer";
import { useTicketOperations } from "./use-ticket-operations";

import { SubmitTicket } from "./staff-composer";
import { StaffTicketDialog } from "./staff-ticket-dialog";

export function StaffWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const { language, setLanguage, t } = useI18n();
  const [healthOpen, setHealthOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const { projects, current: project, select: selectProject } = useCurrentProject(token);
  const composer = useComposer(project);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const { lanes, items: activeItems, loading, invalidSearch, totals, matches, archive, archiveMatches, archivedItems } = useStaffTickets(token, project?._id, showArchived, query);
  const operations = useTicketOperations(token);
  const tags = useTicketTags(token);
  const [selection, setSelection] = useState<{ id: Id<"tickets">; projectId: Id<"projects"> } | null>(null);
  const selectedId = selection?.projectId === project?._id ? selection?.id ?? null : null;
  const setSelectedId = (id: Id<"tickets"> | null) => setSelection(id && project ? { id, projectId: project._id } : null);
  const selected = useSelectedTicket(token, selectedId);

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
    setSelectedId(null);
  }

  return (
    <main className="min-h-screen">
      <Toaster richColors position="bottom-right" />
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
              <Input className="pl-9" placeholder={t("search")} maxLength={200} value={search} onChange={(event) => setSearch(event.target.value)} />
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
            <Button variant={showArchived ? "default" : "outline"} onClick={() => setShowArchived((value) => !value)}>
              <Archive />
              {showArchived ? t("hideArchive") : t("archive")}
            </Button>
            <Button variant="outline" onClick={() => setHealthOpen(true)}>{t("healthTitle")}</Button>
            <LanguageSelector language={language} onChange={setLanguage} />
            <Button variant="outline" size="icon" onClick={() => void onLogout()} aria-label={t("signOut")}>
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
            <TicketExplorer key={project?._id} projectId={project!._id} token={token}
              items={query ? matches?.matches ?? [] : activeItems} archivedItems={archivedItems}
              tags={tags ?? []} search={query} onSearch={setSearch} showArchived={showArchived}
              totals={totals ?? {}} pages={lanes} archive={archive}
              loading={query ? matches === undefined : loading} searchHasMore={matches?.hasMore} archiveSearchHasMore={archiveMatches?.hasMore}
              onSelect={setSelectedId} onMove={moveItem}
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

      {selected?.lifecycle === "archived" ? <ArchivedTicketDialog item={selected} onClose={() => setSelectedId(null)} onRestore={async () => { await operations.restore(selected); }} /> : <StaffTicketDialog
        ticket={selected}
        ticketId={selectedId}
        token={token}
        onClose={() => setSelectedId(null)}
        onMove={(_id, status) => { if (selected) void moveItem(selected, status); }}
        onArchive={archiveItem}
      />}
    </main>
  );
}
