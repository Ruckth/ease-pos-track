import { errorCode } from "../../../shared/errors";
import { DiscardTicketDraft } from "./discard-ticket-draft";
import { ProductWordmark } from "@/components/product-wordmark";
import { queueNeighbors } from "@/lib/staff-ticket-queue";
import { LanguageSelector } from "@/components/auth-screens";
import { NoProjects, ProjectSwitcher, useCurrentProject } from "@/components/project-controls";
import { statusMeta } from "@/components/ticket-status";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { CustomerTicketWizard } from "./customer-ticket-wizard";
import { useI18n } from "@/lib/i18n";
import { formatTicketNumber } from "../../../shared/ticket-numbers";
import { type ProjectSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { Id } from "@convex/_generated/dataModel";
import { Images, Loader2, LogOut, MapPin, Plus } from "lucide-react";
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast, Toaster } from "sonner";
import type { TicketSummary } from "../../../shared/ticket-contracts";
import { useCustomerTickets } from "./adapter";
import { CustomerTicketDialog } from "./customer-ticket-dialog";
import { customerQueue, customerQueueCounts } from "./customer-queue";
import { useComposer } from "./use-composer";
import { useWorkspaceMenu } from "./use-workspace-menu";
import { useWorkspaceNavigation } from "./use-workspace-navigation";

export function CustomerPortal({ token, email, onLogout }: {
  token: string; email: string | null; onLogout: () => Promise<void>;
}) {
  const { language, setLanguage, t } = useI18n();
  const { projects, current: project, select: selectProject } = useCurrentProject(token);
  const navigation = useWorkspaceNavigation("customer", project?.key);
  const composer = useComposer(project);
  const toolsMenu = useWorkspaceMenu();
  const projectId = project?._id;
  const [visible, setVisible] = useState<{ projectId?: Id<"projects">; ids: Id<"tickets">[] }>({ ids: [] });
  const visibleIds = visible.projectId === projectId ? visible.ids : [];
  const setVisibleIds = useCallback((ids: Id<"tickets">[]) => setVisible({ projectId, ids }), [projectId]);
  const previousSelection = useRef(navigation.ticketId);
  const scrollOrigin = useRef<number | null>(null);
  const activeProjectBeforeUpdate = useRef(projectId);
  useEffect(() => {
    if (projects === undefined) return;
    const previous = activeProjectBeforeUpdate.current;
    activeProjectBeforeUpdate.current = projectId;
    if (previous && !projects.some(member => member._id === previous)) toast.info(t("projectMissing"));
  }, [projects, projectId, t]);
  useEffect(() => {
    const previous = previousSelection.current;
    previousSelection.current = navigation.ticketId;
    if (!previous || navigation.ticketId) return;
    const frame = requestAnimationFrame(() => {
      if (scrollOrigin.current !== null) window.scrollTo({ top: scrollOrigin.current, behavior: "instant" });
      scrollOrigin.current = null;
      // Filtering can close detail while focus remains in the search/select.
      // Browser Back removes the focused panel; recover that lost focus only.
      if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) return;
      const row = document.querySelector<HTMLElement>(`button[data-ticket-id="${CSS.escape(previous)}"]`);
      const target = row?.getClientRects().length ? row : document.getElementById("customer-tickets-heading");
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [navigation.ticketId]);
  const sequence = useRef<Id<"tickets">[]>([]);
  const previousProject = useRef(project?._id);
  if (previousProject.current !== project?._id) {
    previousProject.current = project?._id;
    sequence.current = [];
  }
  function openTicket(id: Id<"tickets">) {
    sequence.current = visibleIds;
    scrollOrigin.current = window.scrollY;
    navigation.openTicket(id);
  }
  if (navigation.ticketId && sequence.current.length === 0 && visibleIds.includes(navigation.ticketId)) sequence.current = visibleIds;
  const { previous: previousId, next: nextId } = queueNeighbors(navigation.ticketId, visibleIds, sequence.current);
  const foreignDraft = composer.hasDraft && composer.project?._id !== project?._id;

  return <main className="min-h-screen">
    <Toaster richColors position="bottom-right" />
    <header className="border-b bg-card/90">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <ProductWordmark />
        <div className="flex flex-wrap items-center gap-2 [&>select]:min-h-11 [&>span]:min-h-11">
          {projects && project ? <ProjectSwitcher projects={projects} current={project} onSelect={selectProject} /> : null}
          <details {...toolsMenu.props} className="relative">
            <summary className="flex min-h-11 cursor-pointer items-center rounded-md border px-3 text-sm font-medium">{t("customerQueueMore")}</summary>
            <div className="absolute right-0 z-30 mt-1 grid min-w-56 gap-3 rounded-lg border bg-popover p-3 shadow-lg">
              {email ? <p className="break-all text-xs text-muted-foreground">{email}</p> : null}
              <div className="[&_button]:min-h-11"><LanguageSelector language={language} onChange={setLanguage} /></div>
              <Button variant="outline" className="min-h-11" onClick={() => void onLogout()}><LogOut />{t("signOut")}</Button>
            </div>
          </details>
        </div>
      </div>
    </header>
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6">
      <div className={cn("mb-5 flex flex-wrap items-center justify-between gap-3", navigation.ticketId && "hidden lg:flex")}>
        <div><p className="text-sm text-muted-foreground">{project?.name ?? t("customerPortal")}</p><h1 id="customer-tickets-heading" tabIndex={-1} className="text-2xl font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("yourTickets")}</h1></div>
        <div className="flex flex-wrap items-center gap-2">{composer.hasDraft && composer.project && <span id="customer-draft-project" className="text-sm text-muted-foreground">{composer.project.name} ({composer.project.key})</span>}
        <Button className="min-h-11" type="button" aria-describedby={composer.hasDraft ? "customer-draft-project" : undefined} aria-expanded={composer.open} disabled={!project && !composer.owner} onClick={composer.show}>
          <Plus />{t(composer.hasDraft ? "resumeTicket" : "newTicket")}
        </Button></div>
      </div>
      {foreignDraft ? <div className="mb-4 rounded-lg border bg-muted/30 p-3 text-sm" role="status">{t("customerQueueDraftProject", { project: composer.project?.name ?? "" })}</div> : null}
      <div className={cn("grid items-start gap-4", navigation.ticketId && "lg:grid-cols-[minmax(0,.85fr)_minmax(0,1.15fr)]")}>
        <ProjectTicketsBoundary key={project?._id ?? "none"}>
          <CustomerTickets token={token} project={project} onNewTicket={composer.show} onSelect={openTicket}
            selectedId={navigation.ticketId} filter={navigation.filter} query={navigation.query}
            onFilter={navigation.setFilter} onQuery={navigation.setQuery} onVisibleIds={setVisibleIds} />
        </ProjectTicketsBoundary>
        {project ? <CustomerTicketDialog token={token} projectId={project._id} ticketId={navigation.ticketId} onClose={navigation.closeTicket}
          inResults={navigation.ticketId && visible.projectId === projectId ? visibleIds.includes(navigation.ticketId) : undefined}
          inline initialSection={navigation.section} onPrevious={previousId ? () => navigation.changeTicket(previousId) : undefined}
          onNext={nextId ? () => navigation.changeTicket(nextId) : undefined} /> : null}
      </div>
    </div>
    <Dialog open={composer.open} mobileFullScreen initialFocus={() => document.getElementById("customer-ticket-title")} onOpenChange={composer.setOpen}
      title={t("newTicket")} description={composer.project ? `${composer.project.name} (${composer.project.key})` : t("customerPortalSubtitle")}>

      {composer.project ? <CustomerTicketWizard key={composer.project._id} token={token} draftOwner={composer.owner!}
        active={composer.open} onSubmitted={id => {
          const createdProject = composer.project;
          composer.complete();
          if (id) {
            if (createdProject && createdProject._id !== project?._id) selectProject(createdProject.key);
            sequence.current = createdProject?._id === projectId ? [id, ...visibleIds.filter(item => item !== id)] : [];
            navigation.openTicket(id);
          }
        }} /> : null}
      {composer.hasDraft && <DiscardTicketDraft busy={composer.busy} onDiscard={composer.discard} />}
    </Dialog>
  </main>;
}

/** Keep draft ownership outside a denied Project subscription. */
class ProjectTicketsBoundary extends Component<{ children: ReactNode }, { denied: boolean }> {
  state = { denied: false };
  static getDerivedStateFromError(error: unknown) {
    if (errorCode(error) !== "PROJECT_NOT_FOUND") throw error;
    return { denied: true };
  }
  render() { return this.state.denied ? <ProjectUnavailable /> : this.props.children; }
}

function ProjectUnavailable() {
  const { t } = useI18n();
  return <p role="alert" className="rounded-lg border p-4 text-sm">{t("projectMissing")}</p>;
}

function CustomerTickets({ token, project, onNewTicket, onSelect, selectedId, filter, query, onFilter, onQuery, onVisibleIds }: {
  token: string; project: ProjectSummary | null | undefined; onNewTicket: () => void; onSelect: (id: Id<"tickets">) => void;
  selectedId: Id<"tickets"> | null; filter: string; query: string; onFilter: (filter: string) => void; onQuery: (query: string) => void;
  onVisibleIds: (ids: Id<"tickets">[]) => void;
}) {
  const { t } = useI18n();
  const page = useCustomerTickets(token, project?._id);
  const tickets = page.results;
  const counts = useMemo(() => customerQueueCounts(tickets), [tickets]);
  const visibleTickets = useMemo(() => customerQueue(tickets, filter, query), [tickets, filter, query]);
  useEffect(() => { onVisibleIds(visibleTickets.map(item => item._id)); }, [visibleTickets, onVisibleIds]);
  const options = [
    { value: "active", label: t("customerQueueAllActive"), count: counts.active },
    { value: "waiting", label: t("customerQueueWaiting"), count: counts.waiting },
    { value: "done", label: t("resolvedTickets"), count: counts.done },
    { value: "all", label: t("allTickets"), count: counts.all },
  ];
  const loaded = page.status !== "LoadingFirstPage";
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!loaded || !project) return;
    const timer = window.setTimeout(() => setAnnouncement(t("customerQueueCount", { shown: visibleTickets.length, loaded: tickets.length })), 250);
    return () => window.clearTimeout(timer);
  }, [loaded, project, visibleTickets.length, tickets.length, t]);
  if (project === null) return <NoProjects />;
  if (!project || !loaded) return <div className="grid min-h-48 place-items-center rounded-lg border" role="status"><Loader2 className="size-6 animate-spin" /><span className="sr-only">{t("syncingTickets")}</span></div>;
  return <section className={cn("min-w-0", selectedId && "hidden lg:block")} aria-label={t("yourTickets")}>
    <span className="sr-only" role="status" aria-live="polite">{announcement}</span>
    <div className="mb-3 flex flex-wrap items-end gap-3">
      <label className="min-w-40 flex-1 space-y-1 text-sm"><span>{t("customerQueueSearch")}</span><Input className="min-h-11" value={query} onChange={event => onQuery(event.target.value)} placeholder={t("search")} /></label>
      <label className="grid gap-1 text-sm"><span>{t("ticketStatus")}</span><select className="min-h-11 max-w-full rounded-md border bg-background px-3" value={filter} onChange={event => onFilter(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}{loaded ? ` (${option.count})` : ""}</option>)}
      </select></label>
    </div>
    <p className="mb-3 text-xs leading-5 text-muted-foreground">{t("customerQueueCountsHint")}</p>
    {tickets.length === 0 && page.status === "Exhausted" && !query.trim() && (filter === "all" || filter === "active") ? <div className="space-y-3 rounded-lg border border-dashed p-6"><h2 className="font-semibold">{t("myTicketsEmpty")}</h2><p className="text-sm text-muted-foreground">{t("myTicketsEmptyHint")}</p><Button className="min-h-11" onClick={onNewTicket}><Plus />{t("newTicket")}</Button></div>
      : <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap justify-between gap-2 border-b px-4 py-3 text-xs text-muted-foreground"><p>{t("customerQueueCount", { shown: visibleTickets.length, loaded: tickets.length })}</p><span>{t("customerQueueOrder")}</span></div>
        {visibleTickets.length ? <ul className="divide-y">{visibleTickets.map(ticket => <li key={ticket._id}><CustomerTicketRow item={ticket} selected={ticket._id === selectedId} onSelect={onSelect} /></li>)}</ul>
          : <div className="space-y-3 p-5"><p>{t("customerQueueEmpty")}</p><Button variant="outline" className="min-h-11" onClick={() => { onFilter("all"); onQuery(""); }}>{t("showAllTickets")}</Button></div>}
      </div>}
    {page.status !== "Exhausted" && project ? <Button className="mt-4 min-h-11" disabled={page.status !== "CanLoadMore"} onClick={() => page.loadMore(20)}>{page.status === "LoadingMore" ? <Loader2 className="animate-spin" /> : null}{t("loadOlder")}</Button> : null}
  </section>;
}

function CustomerTicketRow({ item, selected, onSelect }: { item: TicketSummary; selected: boolean; onSelect: (id: Id<"tickets">) => void }) {
  const { t, formatDate } = useI18n();
  const meta = statusMeta(item.status);
  const label = formatTicketNumber(item.ticketNumber, item.projectKey);
  return <button type="button" data-ticket-id={item._id} className={cn("flex min-h-20 w-full flex-col gap-2 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "bg-primary/5")}
    aria-label={[t("viewTicket", { ticket: label }), item.title, t(meta.labelKey)].join(", ")} aria-current={selected ? "true" : undefined} onClick={() => onSelect(item._id)}>
    <span className="break-words text-sm font-semibold">{item.title}</span>
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"><span className="font-mono">{label}</span><span className={cn("font-medium", item.status === "waiting" && "text-violet-700 dark:text-violet-300")}>{item.status === "waiting" ? t("customerQueueWaiting") : t(meta.labelKey)}</span><time dateTime={new Date(item.createdAt).toISOString()}>{formatDate(item.createdAt)}</time></span>
    {item.excerpt ? <span className="line-clamp-1 text-sm text-muted-foreground">{item.excerpt}</span> : null}
    <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
      {item.mediaCount ? <span className="inline-flex items-center gap-1"><Images className="size-3" aria-hidden="true" />{t("reviewMedia", { count: item.mediaCount })}</span> : null}
      {item.annotationCount ? <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden="true" />{t("reviewPins", { count: item.annotationCount })}</span> : null}
    </span>
  </button>;
}
