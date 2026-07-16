import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Toaster, toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Copy,
  ImagePlus,
  Images,
  Loader2,
  LogOut,
  MapPin,
  Pencil,
  PlayCircle,
  RefreshCw,
  Search,
} from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { AnnotationActivityList } from "@/components/annotation-activity";
import { AnnotationList, DescriptionWithTags } from "@/components/annotation-notes";
import { FeedbackActivityList } from "@/components/feedback-activity";
import { MediaUploadField, releasePendingMedia, type PendingMedia } from "@/components/media-upload";
import {
  MediaViewer,
  type AnnotationDraftInput,
  type AnnotationUpdateInput,
  type MediaViewerHandle,
} from "@/components/media-viewer";
import { uploadFiles } from "@/uploadthing";
import { cn } from "@/lib/utils";
import { formatTicketNumber, nextFeedbackStatus } from "@/lib/feedback-ui";
import {
  pendingAnnotationsForCreate,
  pendingAnnotationsForViewer,
  pendingMediaForViewer,
  type PendingAnnotation,
  withoutPendingAnnotationsForMedia,
} from "@/lib/pending-annotations";
import { isActiveAnnotation, isVideoMedia, type Feedback, type FeedbackStatus, type MediaItem } from "@/lib/types";
import { localizeError, useI18n } from "@/lib/i18n";

const SESSION_KEY = "ease-pos-tracking-session";
const CLIENT_ID_KEY = "ease-pos-client-id";

const statuses: Array<{
  value: FeedbackStatus;
  labelKey: "new" | "inProgress" | "waiting" | "done";
  tone: string;
  icon: typeof Clock3;
}> = [
  { value: "new", labelKey: "new", tone: "bg-sky-50 text-sky-800 border-sky-200", icon: ImagePlus },
  { value: "in_progress", labelKey: "inProgress", tone: "bg-amber-50 text-amber-800 border-amber-200", icon: RefreshCw },
  { value: "waiting", labelKey: "waiting", tone: "bg-violet-50 text-violet-800 border-violet-200", icon: Clock3 },
  { value: "done", labelKey: "done", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
];

function getStoredToken() {
  const token = window.sessionStorage.getItem(SESSION_KEY) ?? window.localStorage.getItem(SESSION_KEY) ?? "";
  if (token) window.sessionStorage.setItem(SESSION_KEY, token);
  window.localStorage.removeItem(SESSION_KEY);
  return token;
}

function storeToken(token: string) {
  window.sessionStorage.setItem(SESSION_KEY, token);
}

function clearToken() {
  window.sessionStorage.removeItem(SESSION_KEY);
  window.localStorage.removeItem(SESSION_KEY);
}

function getClientId() {
  const existing = window.localStorage.getItem(CLIENT_ID_KEY);
  if (existing) return existing;
  const clientId = crypto.randomUUID();
  window.localStorage.setItem(CLIENT_ID_KEY, clientId);
  return clientId;
}

function statusMeta(status: FeedbackStatus) {
  return statuses.find((item) => item.value === status) ?? statuses[0];
}


function AppContent() {
  const [token, setToken] = useState(getStoredToken);
  const logout = useMutation(api.auth.logout);
  const sessionValid = useQuery(api.auth.validateSession, { token: token || undefined });

  useEffect(() => {
    if (token && sessionValid === false) {
      clearToken();
      setToken("");
    }
  }, [sessionValid, token]);

  if (!token || sessionValid === false) {
    return <PasswordGate onLogin={setToken} />;
  }

  if (sessionValid === undefined) {
    return <main className="grid min-h-screen place-items-center"><Loader2 className="size-7 animate-spin text-muted-foreground" /></main>;
  }

  return <TrackingWorkspace token={token} onLogout={async () => {
    try {
      await logout({ token });
    } finally {
      clearToken();
      setToken("");
    }
  }} />;
}

function App() {
  return <AppContent />;
}

function PasswordGate({ onLogin }: { onLogin: (token: string) => void }) {
  const { language, setLanguage, t } = useI18n();
  const login = useMutation(api.auth.login);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");

    try {
      const result = await login({ password, clientId: getClientId() });
      storeToken(result.token);
      onLogin(result.token);
    } catch (err) {
      setError(localizeError(err, t));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center justify-between gap-3"><CardTitle>{t("appName")}</CardTitle><LanguageSelector language={language} onChange={setLanguage} /></div>
          <CardDescription>{t("internalBoard")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
              {t("password")}
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoFocus
              />
            </div>
            {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
            <Button className="w-full" disabled={isSubmitting || !password}>
              {isSubmitting ? <Loader2 className="animate-spin" /> : null}{isSubmitting ? t("signingIn") : t("enter")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function LanguageSelector({ language, onChange }: { language: "th" | "en"; onChange: (language: "th" | "en") => void }) {
  const { t } = useI18n();
  return (
    <div className="inline-flex rounded-md border p-0.5" aria-label={t("language")}>
      <Button type="button" size="sm" variant={language === "th" ? "default" : "ghost"} className="h-9 px-3" onClick={() => onChange("th")}>ไทย</Button>
      <Button type="button" size="sm" variant={language === "en" ? "default" : "ghost"} className="h-9 px-3" onClick={() => onChange("en")}>EN</Button>
    </div>
  );
}

function TrackingWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const { language, setLanguage, t, formatDate } = useI18n();
  const [showArchived, setShowArchived] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerHasDraft, setComposerHasDraft] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);
  const feedback = useQuery(api.feedback.listFeedback, { token, includeDeleted: showArchived });
  const updateStatus = useMutation(api.feedback.updateFeedbackStatus);
  const undoStatus = useMutation(api.feedback.undoFeedbackStatus);
  const archiveFeedback = useMutation(api.feedback.archiveFeedback);
  const restoreFeedback = useMutation(api.feedback.restoreFeedback);
  const ensureTicketNumbers = useMutation(api.feedback.ensureTicketNumbers);
  const ticketBackfillRunningRef = useRef(false);
  const [selectedId, setSelectedId] = useState<Id<"feedback"> | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = feedback ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((item) =>
      `${formatTicketNumber(item.ticketNumber)} ${item.title} ${item.description}`.toLowerCase().includes(q)
    );
  }, [feedback, search]);

  useEffect(() => {
    if (!feedback?.some((item) => item.ticketNumber === undefined) || ticketBackfillRunningRef.current) return;
    ticketBackfillRunningRef.current = true;
    void ensureTicketNumbers({ token })
      .catch((error) => toast.error(localizeError(error, t)))
      .finally(() => {
        ticketBackfillRunningRef.current = false;
      });
  }, [ensureTicketNumbers, feedback, token]);

  const selected = feedback?.find((item) => item._id === selectedId) ?? null;
  const activeItems = filtered.filter((item) => item.deletedAt === undefined);
  const archivedItems = filtered.filter((item) => item.deletedAt !== undefined);

  async function moveItem(id: Id<"feedback">, status: FeedbackStatus) {
    const current = feedback?.find((item) => item._id === id);
    if (!current) return;
    try {
      const result = await updateStatus({ token, id, status, expectedVersion: current.version ?? 0 });
      if (!result.eventId) return;
      toast.success(t("statusUpdated"), {
        action: {
          label: t("undo"),
          onClick: () => {
            void undoStatus({ token, eventId: result.eventId!, expectedVersion: result.version })
              .catch((error) => toast.error(localizeError(error, t)));
          },
        },
      });
    } catch (error) {
      toast.error(localizeError(error, t));
    }
  }

  async function restoreItem(id: Id<"feedback">, announce = true) {
    const current = feedback?.find((item) => item._id === id);
    if (!current) return;
    await restoreFeedback({ token, id, expectedVersion: current.version ?? 0 });
    if (announce) toast.success(t("feedbackRestored"));
  }

  async function archiveItem(id: Id<"feedback">) {
    const current = feedback?.find((item) => item._id === id);
    if (!current) return;
    const result = await archiveFeedback({ token, id, expectedVersion: current.version ?? 0 });
    setSelectedId(null);
    toast.success(t("feedbackArchived"), {
      action: {
          label: t("undo"),
        onClick: () => {
          void restoreFeedback({ token, id, expectedVersion: result.version })
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
            <p className="text-sm text-muted-foreground">{feedback ? t("feedbackItems", { count: feedback.length }) : t("syncing")}</p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:flex-nowrap">
            <div className="relative min-w-48 flex-1 basis-full sm:basis-auto lg:w-72 lg:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder={t("search")} value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button
              type="button"
              variant="default"
              aria-expanded={composerOpen}
              onClick={() => setComposerOpen(true)}
            >
              <ImagePlus />
              {composerHasDraft ? t("resumeFeedback") : t("newFeedback")}
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
          {feedback === undefined ? (
            <div className="grid min-h-72 place-items-center rounded-lg border bg-card">
              <Loader2 className="size-7 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-4">
              {statuses.map((status) => {
                const items = activeItems.filter((item) => item.status === status.value);
                return (
                  <BoardColumn
                    key={status.value}
                    status={status.value}
                    items={items}
                    onSelect={setSelectedId}
                    onMove={moveItem}
                  />
                );
              })}
            </div>
          )}
          {showArchived && archivedItems.length > 0 ? (
            <section className="mt-5 rounded-lg border bg-card p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Archive className="size-4" />{t("archivedFeedback")}</h2>
              <div className="space-y-2">
                {archivedItems.map((item) => (
                  <div key={item._id} className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="text-sm leading-5 text-muted-foreground">
                        <span className="font-mono">{formatTicketNumber(item.ticketNumber)}</span>
                        {" · "}{t("archivedOn", { date: formatDate(item.deletedAt ?? item.updatedAt) })}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void restoreItem(item._id).catch((error) => toast.error(localizeError(error, t)))}>
                      <ArchiveRestore /> {t("restore")}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </section>
      </div>

      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (open || !composerBusy) setComposerOpen(open);
        }}
        title={t("newFeedback")}
        description={t("internalBoard")}
        keepMounted
      >
        <SubmitFeedback
          token={token}
          active={composerOpen}
          onSubmissionComplete={() => {
            setComposerHasDraft(false);
            setComposerOpen(false);
          }}
          onDraftStateChange={setComposerHasDraft}
          onUploadBusyChange={setComposerBusy}
        />
      </Dialog>

      <FeedbackDialog
        feedback={selected}
        token={token}
        onClose={() => setSelectedId(null)}
        onMove={moveItem}
        onArchive={archiveItem}
      />
    </main>
  );
}

function SubmitFeedback({
  token,
  active,
  onSubmissionComplete,
  onDraftStateChange,
  onUploadBusyChange,
}: {
  token: string;
  active: boolean;
  onSubmissionComplete: () => void;
  onDraftStateChange: (hasDraft: boolean) => void;
  onUploadBusyChange: (isBusy: boolean) => void;
}) {
  const { t } = useI18n();
  const createFeedback = useMutation(api.feedback.createFeedback);
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
    toast.success(t("feedbackSubmitted"));
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

  async function cancelUploadIntent(intentId: Id<"uploadIntents">, secret: string) {
    const response = await fetch("/api/uploads/cancel", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ intentId, secret }),
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({ error: "UPLOAD_CLEANUP_FAILED" }));
      throw new Error(typeof result.error === "string" ? result.error : "UPLOAD_CLEANUP_FAILED");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");

    if (!title.trim() || items.length === 0) {
      setError(t("requiredFeedback"));
      return;
    }

    setProgress(0);
    let activeIntent: { intentId: Id<"uploadIntents">; secret: string } | null = null;
    try {
      const intent = await createUploadIntent({
        token,
        idempotencyKey: idempotencyKeyRef.current,
        files: items.map((item) => ({ name: item.file.name, size: item.file.size, type: item.file.type })),
      });
      if (intent.feedbackId) {
        finishSubmission();
        return;
      }
      activeIntent = { intentId: intent.intentId, secret: intent.secret };
      const abortController = new AbortController();
      abortControllerRef.current = abortController;
      const uploads = await uploadFiles("feedbackMedia", {
        files: items.map((item) => item.file),
        input: { intentId: intent.intentId, secret: intent.secret },
        headers: { authorization: `Bearer ${token}` },
        signal: abortController.signal,
        onUploadProgress: ({ totalProgress }) => setProgress(Math.round(totalProgress)),
      });

      const media: MediaItem[] = uploads.map((uploaded, index) => {
        const raw = uploaded as typeof uploaded & { ufsUrl?: string; url?: string; type?: string };
        return {
          key: uploaded.key,
          name: uploaded.name,
          size: uploaded.size,
          type: raw.type ?? items[index]?.file.type ?? "",
          url: raw.ufsUrl ?? raw.url ?? "",
        };
      });

      await createFeedback({
        token,
        title,
        description,
        media,
        annotations: pendingAnnotationsForCreate(items, annotations),
        uploadIntentId: intent.intentId,
        uploadIntentSecret: intent.secret,
      });
      activeIntent = null;
      finishSubmission();
    } catch (err) {
      if (activeIntent) {
        try {
          await cancelUploadIntent(activeIntent.intentId, activeIntent.secret);
        } catch (cleanupError) {
          toast.error(localizeError(cleanupError, t));
        }
      }
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

function BoardColumn({
  status,
  items,
  onSelect,
  onMove,
}: {
  status: FeedbackStatus;
  items: Feedback[];
  onSelect: (id: Id<"feedback">) => void;
  onMove: (id: Id<"feedback">, status: FeedbackStatus) => void;
}) {
  const { t } = useI18n();
  const meta = statusMeta(status);
  const Icon = meta.icon;

  return (
    <section className="min-w-0 rounded-lg border bg-card">
      <div className={cn("flex items-center justify-between border-b px-3 py-3", meta.tone)}>
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0" />
          <h2 className="truncate text-sm font-semibold">{t(meta.labelKey)}</h2>
        </div>
        <Badge variant="outline" className="bg-white/70">
          {items.length}
        </Badge>
      </div>
      <div className="space-y-3 p-3">
        {items.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">{t("empty")}</div>
        ) : (
          items.map((item) => <FeedbackCard key={item._id} item={item} onSelect={onSelect} onMove={onMove} />)
        )}
      </div>
    </section>
  );
}

function FeedbackCard({
  item,
  onSelect,
  onMove,
}: {
  item: Feedback;
  onSelect: (id: Id<"feedback">) => void;
  onMove: (id: Id<"feedback">, status: FeedbackStatus) => void;
}) {
  const { t, formatDate } = useI18n();
  const cover = item.media[0];
  const extraCount = item.media.length - 1;
  const pinCount = item.annotations?.filter(isActiveAnnotation).length ?? 0;
  const ticketLabel = formatTicketNumber(item.ticketNumber);
  const nextStatus = nextFeedbackStatus(item.status);
  const currentStatus = statusMeta(item.status);
  const nextStatusLabel = nextStatus ? t(statusMeta(nextStatus).labelKey) : null;

  return (
    <article className="rounded-md border bg-background shadow-sm">
      <button className="block w-full text-left" onClick={() => onSelect(item._id)}>
        <div className="relative overflow-hidden rounded-t-md bg-black">
          {cover ? (
            isVideoMedia(cover) ? (
              <>
                <video className="aspect-video w-full object-cover opacity-80" src={cover.url} muted playsInline preload="metadata" />
                <PlayCircle className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 text-white" />
              </>
            ) : (
              <img className="aspect-video w-full object-cover" src={cover.url} alt="" loading="lazy" />
            )
          ) : (
            <div className="grid aspect-video w-full place-items-center text-sm text-muted-foreground">{t("noMedia")}</div>
          )}
          <span className="pointer-events-none absolute left-1.5 top-1.5 rounded-md bg-black/80 px-2 py-1 font-mono text-sm font-semibold leading-5 text-white shadow-sm">
            {ticketLabel}
          </span>
          {extraCount > 0 ? (
            <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
              <Images className="size-3" />
              +{extraCount}
            </span>
          ) : null}
          {pinCount > 0 ? (
            <span className="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">
              <MapPin className="size-3" />
              {pinCount}
            </span>
          ) : null}
        </div>
        <div className="space-y-2 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          {item.description ? <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{item.description}</p> : null}
          <p className="text-sm leading-5 text-muted-foreground">{formatDate(item.createdAt)}</p>
        </div>
      </button>
      <div className="flex items-center justify-end gap-2 border-t p-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!nextStatus}
          onClick={() => {
            if (nextStatus) onMove(item._id, nextStatus);
          }}
          aria-label={nextStatusLabel ? t("movedTo", { ticket: ticketLabel, status: nextStatusLabel }) : t("ticketComplete", { ticket: ticketLabel })}
          title={nextStatusLabel ? t("movedTo", { ticket: ticketLabel, status: nextStatusLabel }) : t("ticketCompleteTitle")}
          className={cn("h-9 rounded-full px-3 text-sm disabled:opacity-100", currentStatus.tone)}
        >
          {t(currentStatus.labelKey)}
          {nextStatus ? <ChevronRight className="size-3" /> : null}
        </Button>
      </div>
    </article>
  );
}

function FeedbackDialog({
  feedback,
  token,
  onClose,
  onMove,
  onArchive,
}: {
  feedback: Feedback | null;
  token: string;
  onClose: () => void;
  onMove: (id: Id<"feedback">, status: FeedbackStatus) => void;
  onArchive: (id: Id<"feedback">) => Promise<void>;
}) {
  const { t, formatDate } = useI18n();
  const detail = useQuery(api.feedback.getFeedback, feedback ? { token, id: feedback._id } : "skip");
  const activity = useQuery(api.feedback.listAnnotationActivity, feedback ? { token, id: feedback._id } : "skip");
  const feedbackActivity = useQuery(api.feedback.listFeedbackActivity, feedback ? { token, id: feedback._id } : "skip");
  const editFeedback = useMutation(api.feedback.editFeedback);
  const undoFeedbackEdit = useMutation(api.feedback.undoFeedbackEdit);
  const addAnnotation = useMutation(api.feedback.addAnnotation);
  const updateAnnotation = useMutation(api.feedback.updateAnnotation);
  const undoAnnotationUpdate = useMutation(api.feedback.undoAnnotationUpdate);
  const removeAnnotation = useMutation(api.feedback.removeAnnotation);
  const restoreAnnotation = useMutation(api.feedback.restoreAnnotation);
  const viewerRef = useRef<MediaViewerHandle>(null);
  const item = detail ?? feedback;
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [feedbackError, setFeedbackError] = useState("");
  const allAnnotations = item?.annotations ?? [];
  const annotations = allAnnotations.filter(isActiveAnnotation);
  const deletedAnnotations = allAnnotations.filter((annotation) => !isActiveAnnotation(annotation));

  useEffect(() => {
    setEditing(false);
    setEditTitle(item?.title ?? "");
    setEditDescription(item?.description ?? "");
    setFeedbackError("");
  }, [item?._id]);

  async function saveFeedbackEdits() {
    if (!item) return;
    setSavingFeedback(true);
    setFeedbackError("");
    try {
      const result = await editFeedback({
        token,
        id: item._id,
        title: editTitle,
        description: editDescription,
        expectedVersion: item.version ?? 0,
      });
      setEditing(false);
      if ("eventId" in result && result.eventId) {
        toast.success(t("feedbackUpdated"), {
          action: {
            label: t("undo"),
            onClick: () => {
              void undoFeedbackEdit({ token, eventId: result.eventId, expectedVersion: result.version })
                .catch((error) => toast.error(localizeError(error, t)));
            },
          },
        });
      }
    } catch (error) {
      setFeedbackError(localizeError(error, t));
    } finally {
      setSavingFeedback(false);
    }
  }

  async function handleUpdateAnnotation(input: AnnotationUpdateInput) {
    if (!item) return;
    const result = await updateAnnotation({ token, id: item._id, ...input });
    toast.success(t("commentUpdated"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void undoAnnotationUpdate({ token, eventId: result.eventId })
            .catch((error) => toast.error(localizeError(error, t)));
        },
      },
    });
  }

  async function handleRestoreAnnotation(annotationId: string, announce = true) {
    if (!item) return;
    await restoreAnnotation({ token, id: item._id, annotationId });
    if (announce) toast.success(t("commentRestored"));
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!item) return;
    await removeAnnotation({ token, id: item._id, annotationId });
    toast.success(t("commentDeleted"), {
      action: {
        label: t("undo"),
        onClick: () => {
          void handleRestoreAnnotation(annotationId, false).catch((error) => toast.error(localizeError(error, t)));
        },
      },
    });
  }

  async function copyTicketNumber() {
    if (!item) return;
    try {
      await navigator.clipboard.writeText(formatTicketNumber(item.ticketNumber));
      toast.success(t("ticketCopied"));
    } catch {
      toast.error(t("ticketCopyFailed"));
    }
  }

  return (
    <Dialog
      open={Boolean(feedback)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber)} · ${item.title}` : t("feedback")}
    >
      {item ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2.5">
            <div>
              <p className="text-sm font-medium leading-5 text-muted-foreground">{t("ticketNumber")}</p>
              <p className="font-mono text-sm font-semibold">{formatTicketNumber(item.ticketNumber)}</p>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void copyTicketNumber()}>
              <Copy /> {t("copy")}
            </Button>
          </div>
          <MediaViewer
            key={item._id}
            ref={viewerRef}
            media={item.media}
            annotations={annotations}
            onCreateAnnotation={async (input) => {
              await addAnnotation({ token, id: item._id, ...input });
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
                void onArchive(item._id).catch((error) => setFeedbackError(localizeError(error, t)));
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
                  <label htmlFor="edit-feedback-title" className="text-sm font-medium">{t("topic")}</label>
                  <Input id="edit-feedback-title" value={editTitle} maxLength={100} onChange={(event) => setEditTitle(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-feedback-description" className="text-sm font-medium">{t("description")}</label>
                  <Textarea id="edit-feedback-description" rows={5} maxLength={10_000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                  <p className="text-sm leading-5 text-muted-foreground">{t("mediaLinkHint")}</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}>{t("cancel")}</Button>
                  <Button type="button" disabled={savingFeedback || !editTitle.trim()} onClick={() => void saveFeedbackEdits()}>
                    {savingFeedback ? <Loader2 className="animate-spin" /> : null} {t("save")}
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
            {feedbackError ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{feedbackError}</p> : null}
            <AnnotationList
              annotations={annotations}
              deletedAnnotations={deletedAnnotations}
              onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
              onUpdate={async (annotationId, text) => handleUpdateAnnotation({ annotationId, text })}
              onDelete={handleDeleteAnnotation}
              onRestore={handleRestoreAnnotation}
            />
            <AnnotationActivityList events={activity ?? []} />
            <FeedbackActivityList events={feedbackActivity ?? []} />
            <p className="text-sm leading-5 text-muted-foreground">{t("createdAt", { date: formatDate(item.createdAt) })}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export default App;
