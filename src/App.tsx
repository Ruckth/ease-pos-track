import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, usePaginatedQuery } from "convex/react";
import { Toaster, toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  Copy,
  ImagePlus,
  Loader2,
  LogOut,
  Pencil,
  Search,
} from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MAX_URGENCY_SCORE, MIN_URGENCY_SCORE } from "../convex/ticket_state";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import { AuthPage, LanguageSelector } from "@/components/auth-screens";
import { CustomerPortal } from "@/components/customer-portal";
import { TicketActivityList } from "@/components/ticket-activity";
import { statuses, statusMeta } from "@/components/ticket-status";
import { MediaUploadField, releasePendingMedia, type PendingMedia } from "@/components/media-upload";
import {
  MediaViewer,
  type AnnotationDraftInput,
  type AnnotationUpdateInput,
  type MediaViewerHandle,
} from "@/components/media-viewer";
import { isTicketSearchWithinLimits, type TicketSummary } from "../shared/ticket-contracts";
import { TicketCard } from "@/components/ticket-card";
import { useStaffLanes } from "@/lib/ticket-pages";
import { StaffBoard } from "@/components/staff-board";
import { NewProjectDialog, NoProjects, StaffProjectControls, useCurrentProject } from "@/components/project-controls";
import { loginPathForRole, resolveAppRoute } from "@/lib/app-routes";
import { cn } from "@/lib/utils";
import { formatTicketNumber } from "@/lib/ticket-ui";
import { submitTicketDraft } from "@/lib/ticket-submit";
import {
  pendingAnnotationsForViewer,
  pendingMediaForViewer,
  type PendingAnnotation,
  withoutPendingAnnotationsForMedia,
} from "@/lib/pending-annotations";
import { clearToken, getStoredToken, storeToken } from "@/lib/session";
import { isActiveAnnotation, type Ticket, type TicketStatus } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";

function useAppPathname() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const updatePathname = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", updatePathname);
    return () => window.removeEventListener("popstate", updatePathname);
  }, []);

  const navigate = useCallback((path: string, replace = false) => {
    if (window.location.pathname === path) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", path);
    setPathname(path);
  }, []);

  return { pathname, navigate };
}

/** Routes by both URL namespace and the server-validated session role. */
function AppContent() {
  const [token, setToken] = useState(getStoredToken);
  const { pathname, navigate } = useAppPathname();
  const logout = useMutation(api.auth.logout);
  const session = useQuery(api.auth.currentSession, { token: token || undefined });
  const route = resolveAppRoute(
    pathname,
    token && session === undefined
      ? "loading"
      : session?.role ?? "signed-out",
  );
  const redirectTo = route.page === "redirect" ? route.to : null;

  useEffect(() => {
    if (token && session === null) {
      clearToken();
      setToken("");
    }
  }, [session, token]);

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, true);
  }, [navigate, redirectTo]);

  async function signOut(role: "staff" | "customer") {
    try {
      await logout({ token });
    } finally {
      clearToken();
      setToken("");
      navigate(loginPathForRole(role), true);
    }
  }

  if (route.page === "loading" || route.page === "redirect") {
    return (
      <main className="grid min-h-screen place-items-center">
        <Loader2 className="size-7 animate-spin text-muted-foreground" />
      </main>
    );
  }

  if (route.page === "staff-login" || route.page === "customer-login" || route.page === "customer-register") {
    return (
      <AuthPage
        page={route.page}
        onNavigate={(path) => navigate(path)}
        onSignedIn={(nextToken) => {
          storeToken(nextToken);
          setToken(nextToken);
        }}
      />
    );
  }

  if (route.page === "customer-home" && session?.role === "customer") {
    return <CustomerPortal token={token} email={session.email} onLogout={() => signOut("customer")} />;
  }

  if (route.page === "staff-home" && session?.role === "staff") {
    return <TrackingWorkspace token={token} onLogout={() => signOut("staff")} />;
  }

  return (
    <main className="grid min-h-screen place-items-center">
      <Loader2 className="size-7 animate-spin text-muted-foreground" />
    </main>
  );
}

function App() {
  return <AppContent />;
}

function TrackingWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const { language, setLanguage, t, formatDate } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerHasDraft, setComposerHasDraft] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const { projects, current: project, select: selectProject } = useCurrentProject(token);
  const [search, setSearch] = useState("");
  const query = search.trim();
  const invalidSearch = !isTicketSearchWithinLimits(query);
  const { lanes, items: activeItems, loading } = useStaffLanes(token, project?._id, !query);
  const totals = useQuery(api.tickets.laneTotals, project ? { token, projectId: project._id } : "skip");
  const matches = useQuery(api.tickets.searchTickets, project && query && !invalidSearch ? {
    token, projectId: project._id, lifecycle: "active", search: query,
  } : "skip");
  const archive = usePaginatedQuery(api.tickets.pageTickets, project && showArchived && !query ? {
    token, projectId: project._id, lifecycle: "archived",
  } : "skip", { initialNumItems: 20 });
  const archiveMatches = useQuery(api.tickets.searchTickets, project && showArchived && query && !invalidSearch ? {
    token, projectId: project._id, lifecycle: "archived", search: query,
  } : "skip");
  const archivedItems = query ? archiveMatches?.matches ?? [] : archive.results;
  const updateStatus = useMutation(api.tickets.updateTicketStatus);
  const undoStatus = useMutation(api.tickets.undoTicketStatus);
  const archiveTicket = useMutation(api.tickets.archiveTicket);
  const restoreTicket = useMutation(api.tickets.restoreTicket);
  const [selectedId, setSelectedId] = useState<Id<"tickets"> | null>(null);
  const selected = useQuery(api.tickets.getTicket, selectedId ? { token, id: selectedId } : "skip") ?? null;
  useEffect(() => { setSelectedId(null); }, [project?._id]);

  /** Return the committed version; null removes a rejected operation overlay. */
  async function moveItem(current: TicketSummary | Ticket, status: TicketStatus) {
    const id = current._id;
    try {
      const result = await updateStatus({ token, id, status, expectedVersion: current.version });
      if (!result.eventId) return result.version;
      toast.success(t("statusUpdated"), {
        action: {
          label: t("undo"),
          onClick: () => {
            void undoStatus({ token, eventId: result.eventId!, expectedVersion: result.version })
              .catch((error) => toast.error(localizeError(error, t)));
          },
        },
      });
      return result.version;
    } catch (error) {
      toast.error(localizeError(error, t));
      return null;
    }
  }

  async function restoreItem(id: Id<"tickets">, announce = true) {
    const current = archivedItems.find((item) => item._id === id) ?? selected;
    if (!current) return;
    await restoreTicket({ token, id, expectedVersion: current.version });
    if (announce) toast.success(t("ticketRestored"));
  }

  async function archiveItem(id: Id<"tickets">) {
    const current = selected;
    if (!current) return;
    const result = await archiveTicket({ token, id, expectedVersion: current.version });
    setSelectedId(null);
    toast.success(t("ticketArchived"), {
      action: {
          label: t("undo"),
        onClick: () => {
          void restoreTicket({ token, id, expectedVersion: result.version })
            .catch((error) => toast.error(localizeError(error, t)));
        },
      },
    });
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
              aria-expanded={composerOpen}
              disabled={!project}
              onClick={() => setComposerOpen(true)}
            >
              <ImagePlus />
              {composerHasDraft ? t("resumeTicket") : t("newTicket")}
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
        open={composerOpen}
        onOpenChange={(open) => {
          if (open || !composerBusy) setComposerOpen(open);
        }}
        title={t("newTicket")}
        description={project ? `${project.name} (${project.key})` : t("internalBoard")}
        keepMounted
      >
        <SubmitTicket
          token={token}
          projectId={project?._id ?? null}
          active={composerOpen}
          onSubmissionComplete={() => {
            setComposerHasDraft(false);
            setComposerOpen(false);
          }}
          onDraftStateChange={setComposerHasDraft}
          onUploadBusyChange={setComposerBusy}
        />
      </Dialog>

      <NewProjectDialog token={token} open={newProjectOpen} onOpenChange={setNewProjectOpen} onCreated={selectProject} />

      <TicketDialog
        ticket={selected}
        token={token}
        onClose={() => setSelectedId(null)}
        onMove={(_id, status) => { if (selected) void moveItem(selected, status); }}
        onArchive={archiveItem}
      />
    </main>
  );
}

function SubmitTicket({
  token,
  projectId,
  active,
  onSubmissionComplete,
  onDraftStateChange,
  onUploadBusyChange,
}: {
  token: string;
  projectId: Id<"projects"> | null;
  active: boolean;
  onSubmissionComplete: () => void;
  onDraftStateChange: (hasDraft: boolean) => void;
  onUploadBusyChange: (isBusy: boolean) => void;
}) {
  const { t } = useI18n();
  const createTicket = useMutation(api.tickets.createTicket);
  const createUploadIntent = useMutation(api.uploads.createUploadIntent);
  const abortControllerRef = useRef<AbortController | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<PendingMedia[]>([]);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const isUploading = progress !== null;
  const hasDraft = title.length > 0 || description.length > 0 || items.length > 0 || annotations.length > 0;
  const viewerMedia = useMemo(() => pendingMediaForViewer(items), [items]);
  const viewerAnnotations = useMemo(
    () => pendingAnnotationsForViewer(items, annotations),
    [annotations, items],
  );
  const selectedMediaIndex = Math.max(0, items.findIndex((item) => item.id === selectedMediaId));
  const annotationCounts = useMemo(() => annotations.reduce<Record<string, number>>((counts, annotation) => {
    counts[annotation.mediaId] = (counts[annotation.mediaId] ?? 0) + 1;
    return counts;
  }, {}), [annotations]);

  useEffect(() => {
    onDraftStateChange(hasDraft);
  }, [hasDraft, onDraftStateChange]);

  useEffect(() => {
    onUploadBusyChange(isUploading);
  }, [isUploading, onUploadBusyChange]);

  useEffect(() => {
    if (active) titleInputRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (active) return;
    setSelectedMediaId(null);
    setPendingRemoval(null);
  }, [active]);

  function finishSubmission() {
    releasePendingMedia(items);
    setItems([]);
    setAnnotations([]);
    setSelectedMediaId(null);
    setPendingRemoval(null);
    setTitle("");
    setDescription("");
    setError("");
    idempotencyKeyRef.current = crypto.randomUUID();
    toast.success(t("ticketSubmitted"));
    onSubmissionComplete();
  }

  function removePendingItem(item: PendingMedia) {
    URL.revokeObjectURL(item.previewUrl);
    setItems((current) => current.filter((candidate) => candidate.id !== item.id));
    setAnnotations((current) => withoutPendingAnnotationsForMedia(current, item.id));
    setSelectedMediaId((current) => current === item.id ? null : current);
    setPendingRemoval(null);
  }

  function requestPendingItemRemoval(item: PendingMedia) {
    if ((annotationCounts[item.id] ?? 0) === 0) {
      removePendingItem(item);
      return;
    }
    setPendingRemoval(item);
  }

  async function createPendingAnnotation(input: AnnotationDraftInput) {
    const mediaItem = items[input.mediaIndex];
    if (!mediaItem) throw new Error("MEDIA_UNAVAILABLE");
    setAnnotations((current) => [...current, {
      id: crypto.randomUUID(),
      mediaId: mediaItem.id,
      kind: input.kind,
      x: input.x,
      y: input.y,
      time: input.time,
      text: input.text.trim(),
      createdAt: Date.now(),
    }]);
    toast.success(t("pinAdded"));
  }

  async function updatePendingAnnotation(input: AnnotationUpdateInput) {
    setAnnotations((current) => current.map((annotation) => {
      if (annotation.id !== input.annotationId) return annotation;
      return {
        ...annotation,
        ...(input.text === undefined ? {} : { text: input.text.trim() }),
        ...(input.x === undefined ? {} : { x: input.x }),
        ...(input.y === undefined ? {} : { y: input.y }),
        ...(input.time === undefined ? {} : { time: input.time }),
      };
    }));
  }

  async function deletePendingAnnotation(annotationId: string) {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== annotationId));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!title.trim()) {
      setError(t("requiredTicket"));
      return;
    }

    if (!projectId) {
      setError(t("projectMissing"));
      return;
    }

    setProgress(0);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    try {
      await submitTicketDraft(
        {
          token,
          createUploadIntent,
          createTicket: (args) => createTicket({ ...args, projectId }),
          onProgress: setProgress,
          signal: abortController.signal,
          onCleanupError: (cleanupError) => toast.error(localizeError(cleanupError, t)),
          onRequestConflict: () => { idempotencyKeyRef.current = crypto.randomUUID(); },
        },
        { title, description, items, annotations, idempotencyKey: idempotencyKeyRef.current },
      );
      finishSubmission();
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      abortControllerRef.current = null;
      setProgress(null);
    }
  }

  return (
    <>
      <form className="space-y-4" onSubmit={onSubmit}>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="title">
            {t("topic")}
          </label>
          <Input ref={titleInputRef} id="title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="description">
            {t("description")}
          </label>
          <Textarea id="description" maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t("media")}</label>
          <MediaUploadField
            items={items}
            onItemsChange={setItems}
            onPreviewItem={(item) => setSelectedMediaId(item.id)}
            onRequestRemove={requestPendingItemRemoval}
            annotationCounts={annotationCounts}
            disabled={!active || isUploading}
          />
          {items.length > 0 ? (
            <p className="text-sm leading-5 text-muted-foreground">
              {annotations.length > 0
                ? t("pinSummary", { count: annotations.length })
                : t("pinHint")}
            </p>
          ) : null}
        </div>

        {progress !== null ? (
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
          </div>
        ) : null}
        {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
        <div className="flex gap-2">
          <Button className="flex-1" disabled={isUploading}>
            {isUploading ? <Loader2 className="animate-spin" /> : null}
            {isUploading ? t("submitting") : t("submit")}
          </Button>
          {isUploading ? (
            <Button type="button" variant="outline" onClick={() => abortControllerRef.current?.abort()}>
              {t("cancelUpload")}
            </Button>
          ) : null}
        </div>
      </form>

      <Dialog
        open={active && selectedMediaId !== null}
        onOpenChange={(open) => !open && setSelectedMediaId(null)}
        title={items[selectedMediaIndex]?.file.name ?? t("annotateMedia")}
        description={t("annotateDescription")}
      >
        <MediaViewer
          key={selectedMediaId ?? "pending-media"}
          media={viewerMedia}
          annotations={viewerAnnotations}
          initialIndex={selectedMediaIndex}
          onCreateAnnotation={createPendingAnnotation}
          onUpdateAnnotation={updatePendingAnnotation}
          onDeleteAnnotation={deletePendingAnnotation}
        />
      </Dialog>

      <AlertDialog
        open={active && pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title={t("removeMediaPins")}
        description={t("removeMediaDescription", { name: pendingRemoval?.file.name ?? t("media"), count: pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0 })}
        confirmLabel={t("removeMedia")}
        onConfirm={() => {
          if (pendingRemoval) removePendingItem(pendingRemoval);
        }}
      />
    </>
  );
}

function TicketDialog({
  ticket,
  token,
  onClose,
  onMove,
  onArchive,
}: {
  ticket: Ticket | null;
  token: string;
  onClose: () => void;
  onMove: (id: Id<"tickets">, status: TicketStatus) => void;
  onArchive: (id: Id<"tickets">) => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const detail = useQuery(api.tickets.getTicket, ticket ? { token, id: ticket._id } : "skip");
  const activity = useQuery(api.annotations.listAnnotationActivity, ticket ? { token, id: ticket._id } : "skip");
  const ticketActivity = useQuery(api.tickets.listTicketActivity, ticket ? { token, id: ticket._id } : "skip");
  const editTicket = useMutation(api.tickets.editTicket);
  const undoTicketEdit = useMutation(api.tickets.undoTicketEdit);
  const updateUrgencyScore = useMutation(api.tickets.updateUrgencyScore);
  const undoUrgencyScore = useMutation(api.tickets.undoUrgencyScore);
  const addAnnotation = useMutation(api.annotations.addAnnotation);
  const updateAnnotation = useMutation(api.annotations.updateAnnotation);
  const undoAnnotationUpdate = useMutation(api.annotations.undoAnnotationUpdate);
  const removeAnnotation = useMutation(api.annotations.removeAnnotation);
  const restoreAnnotation = useMutation(api.annotations.restoreAnnotation);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const item = detail ?? ticket;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingTicket, setSavingTicket] = useState(false);
  const [urgencyDraft, setUrgencyDraft] = useState("");
  const [savingUrgency, setSavingUrgency] = useState(false);
  const [ticketError, setTicketError] = useState("");
  const allAnnotations = item?.annotations ?? [];
  const annotations = allAnnotations.filter(isActiveAnnotation);
  const deletedAnnotations = allAnnotations.filter((annotation) => !isActiveAnnotation(annotation));

  useEffect(() => {
    setEditing(false);
    setEditTitle(item?.title ?? "");
    setEditDescription(item?.description ?? "");
    setTicketError("");
  }, [item?._id]);

  useEffect(() => {
    setUrgencyDraft(item?.urgencyScore?.toString() ?? "");
  }, [item?._id, item?.urgencyScore]);

  async function saveUrgencyScore() {
    if (!item) return;
    const trimmed = urgencyDraft.trim();
    const urgencyScore = trimmed === "" ? undefined : Number(trimmed);
    if (
      urgencyScore !== undefined
      && (!Number.isInteger(urgencyScore) || urgencyScore < MIN_URGENCY_SCORE || urgencyScore > MAX_URGENCY_SCORE)
    ) {
      setTicketError(t("invalidUrgencyScore"));
      return;
    }

    setSavingUrgency(true);
    setTicketError("");
    try {
      const result = await updateUrgencyScore({
        token,
        id: item._id,
        urgencyScore,
        expectedVersion: item.version,
      });
      setUrgencyDraft(urgencyScore?.toString() ?? "");
      if (result.eventId) {
        toast.success(t("urgencySaved"), {
          action: {
            label: t("undo"),
            onClick: () => {
              void undoUrgencyScore({ token, eventId: result.eventId, expectedVersion: result.version })
                .catch((error) => toast.error(localizeError(error, t)));
            },
          },
        });
      }
    } catch (error) {
      setTicketError(localizeError(error, t));
    } finally {
      setSavingUrgency(false);
    }
  }

  async function saveTicketEdits() {
    if (!item) return;
    setSavingTicket(true);
    setTicketError("");
    try {
      const result = await editTicket({
        token,
        id: item._id,
        title: editTitle,
        description: editDescription,
        expectedVersion: item.version,
      });
      setEditing(false);
      if ("eventId" in result && result.eventId) {
        toast.success(t("ticketUpdated"), {
          action: {
            label: t("undo"),
            onClick: () => {
              void undoTicketEdit({ token, eventId: result.eventId, expectedVersion: result.version })
                .catch((error) => toast.error(localizeError(error, t)));
            },
          },
        });
      }
    } catch (error) {
      setTicketError(localizeError(error, t));
    } finally {
      setSavingTicket(false);
    }
  }

  async function handleUpdateAnnotation(input: AnnotationUpdateInput) {
    if (!item) return;
    const result = await updateAnnotation({ token, id: item._id, ...input, expectedVersion: item.version });
    toast.success(t("commentUpdated"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void undoAnnotationUpdate({ token, eventId: result.eventId, expectedVersion: result.version })
            .catch((error) => toast.error(localizeError(error, t)));
        },
      },
    });
  }

  async function handleRestoreAnnotation(annotationId: string) {
    if (!item) return;
    await restoreAnnotation({ token, id: item._id, annotationId, expectedVersion: item.version });
    toast.success(t("commentRestored"));
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!item) return;
    const result = await removeAnnotation({ token, id: item._id, annotationId, expectedVersion: item.version });
    toast.success(t("commentDeleted"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void restoreAnnotation({ token, id: item._id, annotationId, expectedVersion: result.version })
            .catch((error) => toast.error(localizeError(error, t)));
        },
      },
    });
  }

  async function copyTicketNumber() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(formatTicketNumber(item.ticketNumber, item.projectKey));
      toast.success(t("ticketCopied"));
    } catch {
      toast.error(t("ticketCopyFailed"));
    }
  }

  return (
    <Dialog
      open={Boolean(ticket)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber, item.projectKey)} · ${item.title}` : t("ticket")}
    >
      {item ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium leading-5 text-muted-foreground">{t("ticketNumber")}</p>
              <p className="font-mono text-sm font-semibold">{formatTicketNumber(item.ticketNumber, item.projectKey)}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyTicketNumber()}>
              <Copy /> {t("copy")}
            </Button>
          </div>
          <div className="rounded-md border bg-muted/20 px-3 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-40 flex-1 space-y-1.5">
                <label htmlFor="ticket-urgency-score" className="text-sm font-medium">{t("urgencyScore")}</label>
                <Input
                  id="ticket-urgency-score"
                  type="number"
                  inputMode="numeric"
                  min={MIN_URGENCY_SCORE}
                  max={MAX_URGENCY_SCORE}
                  step={1}
                  value={urgencyDraft}
                  placeholder="—"
                  onChange={(event) => setUrgencyDraft(event.target.value)}
                  aria-describedby="ticket-urgency-hint"
                />
              </div>
              <Button type="button" onClick={() => void saveUrgencyScore()} disabled={savingUrgency}>
                {savingUrgency ? <Loader2 className="animate-spin" /> : null} {t("saveUrgency")}
              </Button>
            </div>
            <p id="ticket-urgency-hint" className="mt-2 text-xs leading-5 text-muted-foreground">{t("urgencyScoreHint")}</p>
          </div>
          <MediaViewer
            key={item._id}
            ref={viewerRef}
            media={item.media}
            annotations={annotations}
            onCreateAnnotation={async (input) => {
              await addAnnotation({ token, id: item._id, ...input, expectedVersion: item.version });
            }}
            onUpdateAnnotation={handleUpdateAnnotation}
            onDeleteAnnotation={handleDeleteAnnotation}
          />
          <div className="flex flex-wrap items-center gap-2">
            {statuses.map((status) => (
              <Button
                key={status.value}
                variant={item.status === status.value ? "default" : "outline"}
                size="sm"
                onClick={() => onMove(item._id, status.value)}
              >
                {t(status.labelKey)}
              </Button>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => {
              setEditTitle(item.title);
              setEditDescription(item.description);
              setEditing(true);
            }}>
              <Pencil /> {t("edit")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (!window.confirm(t("archiveConfirm"))) return;
                void onArchive(item._id).catch((error) => setTicketError(localizeError(error, t)));
              }}
            >
              <Archive /> {t("archive")}
            </Button>
          </div>
          <div className="space-y-3">
            <Badge className={cn("border", statusMeta(item.status).tone)} variant="outline">
              {t(statusMeta(item.status).labelKey)}
            </Badge>
            {editing ? (
              <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <label htmlFor="edit-ticket-title" className="text-sm font-medium">{t("topic")}</label>
                  <Input id="edit-ticket-title" value={editTitle} maxLength={100} onChange={(event) => setEditTitle(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-ticket-description" className="text-sm font-medium">{t("description")}</label>
                  <Textarea id="edit-ticket-description" rows={5} maxLength={10_000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                  <p className="text-sm leading-5 text-muted-foreground">{t("mediaLinkHint")}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t("cancel")}</Button>
                  <Button type="button" disabled={savingTicket || !editTitle.trim()} onClick={() => void saveTicketEdits()}>
                    {savingTicket ? <Loader2 className="animate-spin" /> : null} {t("save")}
                  </Button>
                </div>
              </div>
            ) : (
              item.description ? (
                <DescriptionWithTags
                  text={item.description}
                  annotations={annotations}
                  onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
                />
              ) : (
                <p className="text-sm leading-6 text-muted-foreground">{t("noDescription")}</p>
              )
            )}
            {ticketError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{ticketError}</p> : null}
            <AnnotationList
              annotations={annotations}
              deletedAnnotations={deletedAnnotations}
              onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
              onUpdate={async (annotationId, text) => handleUpdateAnnotation({ annotationId, text })}
              onDelete={handleDeleteAnnotation}
              onRestore={handleRestoreAnnotation}
            />
            <AnnotationActivityList events={activity ?? []} />
            <TicketActivityList events={ticketActivity ?? []} />
            <p className="text-sm leading-5 text-muted-foreground">{t("createdAt", { date: formatDate(item.createdAt) })}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export default App;
