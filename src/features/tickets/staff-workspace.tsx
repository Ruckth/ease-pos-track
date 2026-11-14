import { LanguageSelector } from "@/components/auth-screens";
import { NewProjectDialog, NoProjects, StaffProjectControls, useCurrentProject } from "@/components/project-controls";
import { StaffBoard } from "@/components/staff-board";
import { TicketCard } from "@/components/ticket-card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { localizeError, useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "@/lib/ticket-ui";
import { type Ticket, type TicketStatus } from "@/lib/types";
import type { Id } from "@convex/_generated/dataModel";
import {
  Archive,
  ArchiveRestore,
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
  const { language, setLanguage, t, formatDate } = useI18n();
  const [showArchived, setShowArchived] = useState(false);

  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const { projects, current: project, select: selectProject } = useCurrentProject(token);
  const composer = useComposer(project);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const { lanes, items: activeItems, loading, invalidSearch, totals, matches, archive, archiveMatches, archivedItems } = useStaffTickets(token, project?._id, showArchived, query);
  const operations = useTicketOperations(token);
  const [selection, setSelection] = useState<{ id: Id<"tickets">; projectId: Id<"projects"> } | null>(null);
  const selectedId = selection?.projectId === project?._id ? selection?.id ?? null : null;
  const setSelectedId = (id: Id<"tickets"> | null) => setSelection(id && project ? { id, projectId: project._id } : null);
  const selected = useSelectedTicket(token, selectedId) ?? null;

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
          ) : (query ? matches === undefined : loading) ? (
            <div className="grid min-h-72 place-items-center rounded-lg border bg-card">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
          ) : (
            query ? <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("searchHint")}</p>
              <p className="text-sm">{t(matches?.hasMore ? "searchLoaded" : "searchMatches", { count: matches?.matches.length ?? 0 })}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{matches?.matches.map(item => <TicketCard key={item._id} item={item} onSelect={setSelectedId} />)}</div>
            </div> : <StaffBoard key={project?._id} projectId={project!._id} token={token} items={activeItems} totals={totals ?? {}} pages={lanes} onSelect={setSelectedId} onMoveCard={moveItem} />
          )}
          {showArchived && archivedItems.length > 0 ? (
            <section className="mt-5 rounded-lg border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Archive className="size-4" />{t("archivedTicket")}</h2>
              <div className="space-y-2">
                {archivedItems.map((item) => (
                  <div key={item._id} className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="text-sm leading-5 text-muted-foreground">
                        <span className="font-mono">{formatTicketNumber(item.ticketNumber, item.projectKey)}</span>
                        {" · "}{t("archivedOn", { date: formatDate(item.archivedAt ?? item.updatedAt) })}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void restoreItem(item._id).catch((error) => toast.error(localizeError(error, t)))}>
                      <ArchiveRestore /> {t("restore")}
                    </Button>
                  </div>
                ))}
              </div>
              {query ? archiveMatches?.hasMore ? <p className="text-sm text-muted-foreground">{t("searchLoaded", { count: archivedItems.length })}</p> : null : archive.status !== "Exhausted" ? <Button disabled={archive.status !== "CanLoadMore"} onClick={() => archive.loadMore(20)}>{t("loadOlder")}</Button> : null}
            </section>
          ) : null}
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

      <NewProjectDialog token={token} open={newProjectOpen} onOpenChange={setNewProjectOpen} onCreated={selectProject} />

      <StaffTicketDialog
        ticket={selected}
        token={token}
        onClose={() => setSelectedId(null)}
        onMove={(_id, status) => { if (selected) void moveItem(selected, status); }}
        onArchive={archiveItem}
      />
    </main>
  );
}
