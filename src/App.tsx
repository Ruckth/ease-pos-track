import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Toaster, toast } from "sonner";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronRight,
  Clock3,
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

const SESSION_KEY = "ease-pos-tracking-session";
const CLIENT_ID_KEY = "ease-pos-client-id";

const statuses: Array<{
  value: FeedbackStatus;
  label: string;
  tone: string;
  icon: typeof Clock3;
}> = [
  { value: "new", label: "New", tone: "bg-sky-50 text-sky-800 border-sky-200", icon: ImagePlus },
  { value: "in_progress", label: "In Progress", tone: "bg-amber-50 text-amber-800 border-amber-200", icon: RefreshCw },
  { value: "waiting", label: "Waiting", tone: "bg-violet-50 text-violet-800 border-violet-200", icon: Clock3 },
  { value: "done", label: "Done", tone: "bg-emerald-50 text-emerald-800 border-emerald-200", icon: CheckCircle2 },
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

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function App() {
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

function PasswordGate({ onLogin }: { onLogin: (token: string) => void }) {
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
      setError(err instanceof Error ? err.message : "Unable to sign in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Ease POS Tracking</CardTitle>
          <CardDescription>Internal feedback board</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-medium" htmlFor="password">
                Password
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
              {isSubmitting ? <Loader2 className="animate-spin" /> : null}
              Enter
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}

function TrackingWorkspace({ token, onLogout }: { token: string; onLogout: () => Promise<void> }) {
  const [showArchived, setShowArchived] = useState(false);
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
      .catch((error) => toast.error(errorMessage(error)))
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
      toast.success("Status updated", {
        action: {
          label: "Undo",
          onClick: () => {
            void undoStatus({ token, eventId: result.eventId!, expectedVersion: result.version })
              .catch((error) => toast.error(errorMessage(error)));
          },
        },
      });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function restoreItem(id: Id<"feedback">, announce = true) {
    const current = feedback?.find((item) => item._id === id);
    if (!current) return;
    await restoreFeedback({ token, id, expectedVersion: current.version ?? 0 });
    if (announce) toast.success("Feedback restored");
  }

  async function archiveItem(id: Id<"feedback">) {
    const current = feedback?.find((item) => item._id === id);
    if (!current) return;
    const result = await archiveFeedback({ token, id, expectedVersion: current.version ?? 0 });
    setSelectedId(null);
    toast.success("Feedback archived for 30 days", {
      action: {
        label: "Undo",
        onClick: () => {
          void restoreFeedback({ token, id, expectedVersion: result.version })
            .catch((error) => toast.error(errorMessage(error)));
        },
      },
    });
  }

  return (
    <main className="min-h-screen">
      <Toaster richColors position="bottom-right" />
      <header className="border-b bg-card/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal">Ease POS Tracking</h1>
            <p className="text-sm text-muted-foreground">{feedback ? `${feedback.length} feedback item${feedback.length === 1 ? "" : "s"}` : "Syncing"}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1 sm:w-72">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button variant={showArchived ? "default" : "outline"} onClick={() => setShowArchived((value) => !value)}>
              <Archive />
              {showArchived ? "Hide archive" : "Archive"}
            </Button>
            <Button variant="outline" size="icon" onClick={() => void onLogout()} aria-label="Sign out">
              <LogOut />
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:grid-cols-[380px_1fr]">
        <SubmitFeedback token={token} />
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
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold"><Archive className="size-4" />Archived feedback</h2>
              <div className="space-y-2">
                {archivedItems.map((item) => (
                  <div key={item._id} className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{formatTicketNumber(item.ticketNumber)}</span>
                        {" · "}Archived {formatDate(item.deletedAt ?? item.updatedAt)}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void restoreItem(item._id).catch((error) => toast.error(errorMessage(error)))}>
                      <ArchiveRestore /> Restore
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </section>
      </div>

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

function SubmitFeedback({ token }: { token: string }) {
  const createFeedback = useMutation(api.feedback.createFeedback);
  const createUploadIntent = useMutation(api.uploads.createUploadIntent);
  const abortControllerRef = useRef<AbortController | null>(null);
  const idempotencyKeyRef = useRef(crypto.randomUUID());
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [items, setItems] = useState<PendingMedia[]>([]);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>([]);
  const [selectedMediaId, setSelectedMediaId] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingMedia | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
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

  function resetForm() {
    releasePendingMedia(items);
    setItems([]);
    setAnnotations([]);
    setSelectedMediaId(null);
    setPendingRemoval(null);
    setTitle("");
    setDescription("");
    setSuccess(true);
    idempotencyKeyRef.current = crypto.randomUUID();
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
    if (!mediaItem) throw new Error("This media item is no longer available.");
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
    toast.success("Pin added to draft");
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
      const result = await response.json().catch(() => ({ error: "Unable to clean up uploaded files." }));
      throw new Error(typeof result.error === "string" ? result.error : "Unable to clean up uploaded files.");
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(false);

    if (!title.trim() || !description.trim() || items.length === 0) {
      setError("Topic, description, and at least one photo or video are required.");
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
        resetForm();
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
      resetForm();
    } catch (err) {
      if (activeIntent) {
        try {
          await cancelUploadIntent(activeIntent.intentId, activeIntent.secret);
        } catch (cleanupError) {
          toast.error(errorMessage(cleanupError));
        }
      }
      setError(err instanceof Error ? err.message : "Unable to submit feedback");
    } finally {
      abortControllerRef.current = null;
      setProgress(null);
    }
  }

  const isUploading = progress !== null;

  return (
    <>
      <Card className="h-fit">
        <CardHeader>
          <CardTitle>New Feedback</CardTitle>
          <CardDescription>Problem report</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="title">
              Topic
            </label>
            <Input id="title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="description">
              Description
            </label>
            <Textarea id="description" maxLength={10_000} value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Media</label>
            <MediaUploadField
              items={items}
              onItemsChange={setItems}
              onPreviewItem={(item) => setSelectedMediaId(item.id)}
              onRequestRemove={requestPendingItemRemoval}
              annotationCounts={annotationCounts}
              disabled={isUploading}
            />
            {items.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {annotations.length > 0
                  ? `${annotations.length} pin${annotations.length === 1 ? "" : "s"} ready to submit. Click media to review or add more.`
                  : "Click a photo or video to add pins and descriptions before submitting."}
              </p>
            ) : null}
          </div>

          {progress !== null ? (
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          ) : null}
          {success ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Feedback submitted.</p> : null}
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button className="flex-1" disabled={isUploading}>
              {isUploading ? <Loader2 className="animate-spin" /> : null}
              Submit
            </Button>
            {isUploading ? (
              <Button type="button" variant="outline" onClick={() => abortControllerRef.current?.abort()}>
                Cancel upload
              </Button>
            ) : null}
          </div>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={selectedMediaId !== null}
        onOpenChange={(open) => !open && setSelectedMediaId(null)}
        title={items[selectedMediaIndex]?.file.name ?? "Annotate media"}
        description="Add a pin, then describe the issue at that point."
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
        open={pendingRemoval !== null}
        onOpenChange={(open) => !open && setPendingRemoval(null)}
        title="Remove media and pins?"
        description={`${pendingRemoval?.file.name ?? "This media item"} has ${pendingRemoval ? annotationCounts[pendingRemoval.id] ?? 0 : 0} pin descriptions. Removing it will discard those pins.`}
        confirmLabel="Remove media"
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
  const meta = statusMeta(status);
  const Icon = meta.icon;

  return (
    <section className="min-w-0 rounded-lg border bg-card">
      <div className={cn("flex items-center justify-between border-b px-3 py-3", meta.tone)}>
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0" />
          <h2 className="truncate text-sm font-semibold">{meta.label}</h2>
        </div>
        <Badge variant="outline" className="bg-white/70">
          {items.length}
        </Badge>
      </div>
      <div className="space-y-3 p-3">
        {items.length === 0 ? (
          <div className="grid min-h-24 place-items-center rounded-md border border-dashed text-sm text-muted-foreground">Empty</div>
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
  const cover = item.media[0];
  const extraCount = item.media.length - 1;
  const pinCount = item.annotations?.filter(isActiveAnnotation).length ?? 0;
  const ticketLabel = formatTicketNumber(item.ticketNumber);
  const nextStatus = nextFeedbackStatus(item.status);
  const currentStatus = statusMeta(item.status);
  const nextStatusLabel = nextStatus ? statusMeta(nextStatus).label : null;

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
            <div className="grid aspect-video w-full place-items-center text-xs text-muted-foreground">No media</div>
          )}
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
          <p className="line-clamp-2 text-sm leading-5 text-muted-foreground">{item.description}</p>
          <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 border-t p-2">
        <span className="font-mono text-xs font-medium text-muted-foreground">{ticketLabel}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!nextStatus}
          onClick={() => {
            if (nextStatus) onMove(item._id, nextStatus);
          }}
          aria-label={nextStatusLabel ? `Move ${ticketLabel} to ${nextStatusLabel}` : `${ticketLabel} is Done`}
          title={nextStatusLabel ? `Move to ${nextStatusLabel}` : "Ticket is complete"}
          className={cn("h-7 rounded-full px-2.5 text-xs disabled:opacity-100", currentStatus.tone)}
        >
          {currentStatus.label}
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
        toast.success("Feedback updated", {
          action: {
            label: "Undo",
            onClick: () => {
              void undoFeedbackEdit({ token, eventId: result.eventId, expectedVersion: result.version })
                .catch((error) => toast.error(errorMessage(error)));
            },
          },
        });
      }
    } catch (error) {
      setFeedbackError(errorMessage(error));
    } finally {
      setSavingFeedback(false);
    }
  }

  async function handleUpdateAnnotation(input: AnnotationUpdateInput) {
    if (!item) return;
    const result = await updateAnnotation({ token, id: item._id, ...input });
    toast.success("Comment updated", {
      action: {
        label: "Undo",
        onClick: () => {
          void undoAnnotationUpdate({ token, eventId: result.eventId })
            .catch((error) => toast.error(errorMessage(error)));
        },
      },
    });
  }

  async function handleRestoreAnnotation(annotationId: string, announce = true) {
    if (!item) return;
    await restoreAnnotation({ token, id: item._id, annotationId });
    if (announce) toast.success("Comment restored");
  }

  async function handleDeleteAnnotation(annotationId: string) {
    if (!item) return;
    await removeAnnotation({ token, id: item._id, annotationId });
    toast.success("Comment deleted", {
      action: {
        label: "Undo",
        onClick: () => {
          void handleRestoreAnnotation(annotationId, false).catch((error) => toast.error(errorMessage(error)));
        },
      },
    });
  }

  return (
    <Dialog
      open={Boolean(feedback)}
      onOpenChange={(open) => !open && onClose()}
      title={item ? `${formatTicketNumber(item.ticketNumber)} · ${item.title}` : "Feedback"}
    >
      {item ? (
        <div className="space-y-4">
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
                {status.label}
              </Button>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => {
              setEditTitle(item.title);
              setEditDescription(item.description);
              setEditing(true);
            }}>
              <Pencil /> Edit
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                if (!window.confirm("Archive this feedback? It can be restored for 30 days.")) return;
                void onArchive(item._id).catch((error) => setFeedbackError(errorMessage(error)));
              }}
            >
              <Archive /> Archive
            </Button>
          </div>
          <div className="space-y-3">
            <Badge className={cn("border", statusMeta(item.status).tone)} variant="outline">
              {statusMeta(item.status).label}
            </Badge>
            {editing ? (
              <div className="space-y-3 rounded-md border bg-muted/20 p-3">
                <div className="space-y-1.5">
                  <label htmlFor="edit-feedback-title" className="text-sm font-medium">Topic</label>
                  <Input id="edit-feedback-title" value={editTitle} maxLength={100} onChange={(event) => setEditTitle(event.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <label htmlFor="edit-feedback-description" className="text-sm font-medium">Description</label>
                  <Textarea id="edit-feedback-description" rows={5} maxLength={10_000} value={editDescription} onChange={(event) => setEditDescription(event.target.value)} />
                  <p className="text-xs text-muted-foreground">Use [1], [2], and similar labels to link to media comments.</p>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
                  <Button type="button" disabled={savingFeedback || !editTitle.trim() || !editDescription.trim()} onClick={() => void saveFeedbackEdits()}>
                    {savingFeedback ? <Loader2 className="animate-spin" /> : null} Save
                  </Button>
                </div>
              </div>
            ) : (
              <DescriptionWithTags
                text={item.description}
                annotations={annotations}
                onFocus={(annotation) => viewerRef.current?.focusAnnotation(annotation)}
              />
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
            <p className="text-xs text-muted-foreground">Created {formatDate(item.createdAt)}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

export default App;
