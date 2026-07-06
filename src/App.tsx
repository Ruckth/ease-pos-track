import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Camera,
  CheckCircle2,
  Clock3,
  ImagePlus,
  Loader2,
  LogOut,
  PlayCircle,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadFiles } from "@/uploadthing";
import { cn } from "@/lib/utils";

const SESSION_KEY = "ease-pos-tracking-session";

type Feedback = Doc<"feedback">;
type Status = Feedback["status"];
type MediaPayload = Feedback["media"];

const statuses: Array<{
  value: Status;
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
  return window.localStorage.getItem(SESSION_KEY) ?? "";
}

function storeToken(token: string) {
  window.localStorage.setItem(SESSION_KEY, token);
}

function clearToken() {
  window.localStorage.removeItem(SESSION_KEY);
}

function statusMeta(status: Status) {
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

function App() {
  const [token, setToken] = useState(getStoredToken);
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

  return <TrackingWorkspace token={token} onLogout={() => {
    clearToken();
    setToken("");
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
      const result = await login({ password });
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

function TrackingWorkspace({ token, onLogout }: { token: string; onLogout: () => void }) {
  const feedback = useQuery(api.feedback.listFeedback, { token });
  const updateStatus = useMutation(api.feedback.updateFeedbackStatus);
  const [selectedId, setSelectedId] = useState<Id<"feedback"> | null>(null);
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const rows = feedback ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(q));
  }, [feedback, search]);

  const selected = feedback?.find((item) => item._id === selectedId) ?? null;

  async function moveItem(id: Id<"feedback">, status: Status) {
    await updateStatus({ token, id, status });
  }

  return (
    <main className="min-h-screen">
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
            <Button variant="outline" size="icon" onClick={onLogout} aria-label="Sign out">
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
                const items = filtered.filter((item) => item.status === status.value);
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
        </section>
      </div>

      <FeedbackDialog feedback={selected} token={token} onClose={() => setSelectedId(null)} onMove={moveItem} />
    </main>
  );
}

function SubmitFeedback({ token }: { token: string }) {
  const createFeedback = useMutation(api.feedback.createFeedback);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (!file) {
      setPreviewUrl("");
      return;
    }

    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function onFileChange(nextFile: File | undefined) {
    setSuccess(false);
    setError("");
    setFile(nextFile ?? null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSuccess(false);

    if (!title.trim() || !description.trim() || !file) {
      setError("Topic, description, and media are required.");
      return;
    }

    setProgress(0);
    try {
      const [uploaded] = await uploadFiles("feedbackMedia", {
        files: [file],
        onUploadProgress: ({ progress: nextProgress }) => setProgress(nextProgress),
      });

      const raw = uploaded as typeof uploaded & { ufsUrl?: string; url?: string; type?: string };
      const media: MediaPayload = {
        key: uploaded.key,
        name: uploaded.name,
        size: uploaded.size,
        type: raw.type ?? file.type,
        url: raw.ufsUrl ?? raw.url ?? "",
      };

      await createFeedback({ token, title, description, media });
      setTitle("");
      setDescription("");
      setFile(null);
      setSuccess(true);
      if (uploadInputRef.current) uploadInputRef.current.value = "";
      if (cameraInputRef.current) cameraInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to submit feedback");
    } finally {
      setProgress(null);
    }
  }

  const isUploading = progress !== null;

  return (
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
            <Textarea id="description" value={description} onChange={(event) => setDescription(event.target.value)} />
          </div>

          <div className="space-y-3">
            <label className="text-sm font-medium">Media</label>
            <div className="grid grid-cols-2 gap-2">
              <Button type="button" variant="outline" onClick={() => cameraInputRef.current?.click()}>
                <Camera />
                Camera
              </Button>
              <Button type="button" variant="outline" onClick={() => uploadInputRef.current?.click()}>
                <Upload />
                Upload
              </Button>
            </div>
            <input
              ref={cameraInputRef}
              className="hidden"
              type="file"
              accept="image/*,video/*"
              capture="environment"
              onChange={(event) => onFileChange(event.target.files?.[0])}
            />
            <input
              ref={uploadInputRef}
              className="hidden"
              type="file"
              accept="image/*,video/*"
              onChange={(event) => onFileChange(event.target.files?.[0])}
            />
            <MediaPreview file={file} previewUrl={previewUrl} />
          </div>

          {progress !== null ? (
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
            </div>
          ) : null}
          {success ? <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Feedback submitted.</p> : null}
          {error ? <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
          <Button className="w-full" disabled={isUploading}>
            {isUploading ? <Loader2 className="animate-spin" /> : null}
            Submit
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function MediaPreview({ file, previewUrl }: { file: File | null; previewUrl: string }) {
  if (!file || !previewUrl) {
    return (
      <div className="grid aspect-video place-items-center rounded-lg border border-dashed bg-muted/40 text-sm text-muted-foreground">
        No media selected
      </div>
    );
  }

  const isVideo = file.type.startsWith("video/");
  return (
    <div className="overflow-hidden rounded-lg border bg-black">
      {isVideo ? (
        <video className="aspect-video w-full object-contain" src={previewUrl} controls />
      ) : (
        <img className="aspect-video w-full object-contain" src={previewUrl} alt="" />
      )}
      <div className="flex items-center justify-between gap-3 bg-card px-3 py-2 text-xs">
        <span className="min-w-0 truncate font-medium">{file.name}</span>
        <span className="shrink-0 text-muted-foreground">{Math.ceil(file.size / 1024)} KB</span>
      </div>
    </div>
  );
}

function BoardColumn({
  status,
  items,
  onSelect,
  onMove,
}: {
  status: Status;
  items: Feedback[];
  onSelect: (id: Id<"feedback">) => void;
  onMove: (id: Id<"feedback">, status: Status) => void;
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
  onMove: (id: Id<"feedback">, status: Status) => void;
}) {
  const isVideo = item.media.type.startsWith("video/");

  return (
    <article className="rounded-md border bg-background shadow-sm">
      <button className="block w-full text-left" onClick={() => onSelect(item._id)}>
        <div className="relative overflow-hidden rounded-t-md bg-black">
          {isVideo ? (
            <>
              <video className="aspect-video w-full object-cover opacity-80" src={item.media.url} muted />
              <PlayCircle className="absolute left-1/2 top-1/2 size-9 -translate-x-1/2 -translate-y-1/2 text-white" />
            </>
          ) : (
            <img className="aspect-video w-full object-cover" src={item.media.url} alt="" loading="lazy" />
          )}
        </div>
        <div className="space-y-2 p-3">
          <h3 className="line-clamp-2 text-sm font-semibold leading-5">{item.title}</h3>
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</p>
          <p className="text-xs text-muted-foreground">{formatDate(item.createdAt)}</p>
        </div>
      </button>
      <div className="border-t p-2">
        <select
          className="h-9 w-full rounded-md border bg-background px-2 text-xs"
          value={item.status}
          onChange={(event) => onMove(item._id, event.target.value as Status)}
          aria-label="Status"
        >
          {statuses.map((status) => (
            <option key={status.value} value={status.value}>
              {status.label}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}

function FeedbackDialog({
  feedback,
  token,
  onClose,
  onMove,
}: {
  feedback: Feedback | null;
  token: string;
  onClose: () => void;
  onMove: (id: Id<"feedback">, status: Status) => void;
}) {
  const detail = useQuery(api.feedback.getFeedback, feedback ? { token, id: feedback._id } : "skip");
  const item = detail ?? feedback;

  return (
    <Dialog open={Boolean(feedback)} onOpenChange={(open) => !open && onClose()} title={item?.title ?? "Feedback"}>
      {item ? (
        <div className="space-y-4">
          <RemoteMedia media={item.media} />
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
          </div>
          <div className="space-y-2">
            <Badge className={cn("border", statusMeta(item.status).tone)} variant="outline">
              {statusMeta(item.status).label}
            </Badge>
            <p className="whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{item.description}</p>
            <p className="text-xs text-muted-foreground">Created {formatDate(item.createdAt)}</p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function RemoteMedia({ media }: { media: MediaPayload }) {
  const isVideo = media.type.startsWith("video/");

  return (
    <div className="overflow-hidden rounded-lg border bg-black">
      {isVideo ? (
        <video className="max-h-[60vh] w-full object-contain" src={media.url} controls />
      ) : (
        <img className="max-h-[60vh] w-full object-contain" src={media.url} alt="" />
      )}
    </div>
  );
}

export default App;
