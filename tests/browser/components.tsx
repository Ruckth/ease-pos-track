// Browser harness for production UI components with explicit in-memory data:
// the Project switcher (three Projects to two), customer Ticket rows in all
// five states and two independent Undo notifications. No backend is involved.
import type { Id } from "../../convex/_generated/dataModel";
import type { Annotation, AnnotationDraftInput, PendingMedia, ProjectSummary, TicketStatus } from "../../src/lib/types";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { TicketAdapter } from "../../src/features/tickets/operations";
import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useI18n } from "../../src/lib/i18n";
import { CameraCaptureDialog } from "../../src/components/camera-capture-dialog";
import { MediaUploadField } from "../../src/components/media-upload";
import { MediaViewer, type MediaViewerHandle } from "../../src/components/media-viewer";
import { ProjectSwitcher } from "../../src/components/project-controls";
import { CustomerTicketRow } from "../../src/features/tickets/customer-ticket-row";
import { ticketOperations } from "../../src/features/tickets/operations";
import { operationNotices } from "../../src/features/tickets/use-ticket-operations";
import { AppToaster } from "../../src/components/ui/sonner";
import "../../src/index.css";

declare global {
  interface Window {
    __bumpMediaHarness?: () => void;
    __mediaSaveControl?: {
      calls: number;
      resolveNext: () => void;
      rejectNext: (message: string) => void;
    };
  }
}

const params = new URLSearchParams(location.search);
if (params.get("theme") === "dark") document.documentElement.classList.add("dark");
const project = (key: string, name: string) => ({ _id: `project-${key}` as Id<"projects">, key, name });
const initialProjects: ProjectSummary[] = [
  project("POS", "Point of Sale"),
  project("APP", "Customer App"),
  project("FLD", params.has("long") ? "โครงการบริการภาคสนามสำหรับสาขาต่างจังหวัดที่มีชื่อยาวมากเป็นพิเศษ" : "Field Service"),
];
const statuses: TicketStatus[] = ["new", "acknowledged", "in_progress", "waiting", "done"];
const rows = statuses.map((status, index) => ({
  _id: `ticket-${status}` as Id<"tickets">, _creationTime: index, projectId: initialProjects[0]._id, projectKey: "POS",
  ticketNumber: index + 1, title: index === 3 ? "Receipt printer stops after the second copy and the drawer stays locked during close" : `Sample Ticket ${index + 1}`,
  excerpt: "Sample description", status, createdAt: Date.UTC(2026, 10, 1 + index), updatedAt: Date.UTC(2026, 10, 1 + index),
  mediaCount: index % 2, annotationCount: index === 2 ? 1 : 0, version: 0, lifecycle: "active", origin: "customer", tags: [], tagIds: [],
  // The waiting row carries the team's open question, the way a reply request arrives.
  ...status === "waiting" ? { latestReply: { role: "staff", at: Date.UTC(2026, 10, 5), excerpt: "Which printer model is it?", awaitingCustomer: true } } : {},
}) as unknown as TicketSummary);

function Switcher() {
  const [projects, setProjects] = useState(initialProjects);
  const [current, setCurrent] = useState(initialProjects[0]);
  const [selected, setSelected] = useState("");
  const [created, setCreated] = useState(0);
  return <section aria-label="Switcher harness" className={`flex w-full ${params.get("align") === "right" ? "justify-end" : "justify-start"}`}>
    <div className="grid justify-items-start gap-2">
      <ProjectSwitcher projects={projects} current={current} onSelect={key => { setSelected(key); setCurrent(projects.find(item => item.key === key) ?? current); }}
        onCreate={params.has("create") ? () => setCreated(count => count + 1) : undefined} />
      <button type="button" onClick={() => { const next = projects.filter(item => item.key !== "POS"); setProjects(next); setCurrent(next[0]); }}>Revoke POS</button>
      <output id="selected">{selected}</output><output id="created">{created}</output>
    </div>
  </section>;
}

function Rows() {
  const [selected, setSelected] = useState<string>("");
  return <ul aria-label="Ticket rows" className="grid gap-2">{rows.map(item => <li key={item._id}>
    <CustomerTicketRow item={item} selected={item._id === selected} onSelect={setSelected} />
  </li>)}</ul>;
}

function Notices() {
  const { t } = useI18n();
  const [undone, setUndone] = useState<string[]>([]);
  const operations = useMemo(() => {
    let event = 0;
    const adapter = {
      status: async (args: { id: string }) => ({ version: 1, eventId: `event-${args.id}-${++event}` }),
      undoStatus: async (args: { eventId: string }) => { setUndone(list => [...list, args.eventId]); return { version: 2 }; },
    } as unknown as TicketAdapter;
    return ticketOperations(adapter, operationNotices(t));
  }, [t]);
  const target = (id: string) => ({ _id: id as Id<"tickets">, version: 0, projectKey: "POS", ticketNumber: id === "A" ? 1 : 2 });
  return <section aria-label="Notification harness" className="grid justify-items-start gap-2">
    <button type="button" onClick={() => { void operations.status(target("A"), "done"); void operations.status(target("B"), "waiting"); }}>Update two Tickets</button>
    <output id="undone">{undone.join(",")}</output>
  </section>;
}

const samplePhotoUrl = (fill = "white", label = "") =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${fill}"/>${label ? `<text x="16" y="40" font-size="24" fill="#111">${label}</text>` : ""}</svg>`,
  );

function NoteChanges() {
  const viewer = useRef<MediaViewerHandle>(null);
  const [archived, setArchived] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([
    { id: "unavailable-note", label: 1, mediaIndex: 0, kind: "point", x: .4, y: .6, text: "Original note", createdAt: 1 },
  ]);
  const photoUrl = samplePhotoUrl();
  const media = [1, 2].map(index => ({ key: String(index), name: `Attachment ${index}.png`, size: 100, type: "image/png", url: photoUrl }));
  return <section aria-label="Live note changes">
    <button type="button" onClick={() => setNotes([])}>Remove note remotely</button>
    <button type="button" onClick={() => setArchived(true)}>Archive remotely</button>
    <button type="button" onClick={() => viewer.current?.requestClose(() => setArchived(true))}>Archive in place</button>
    {archived && <p>Archived</p>}
    <MediaViewer ref={viewer} media={media} annotations={notes} readOnly={archived}
      onCreateAnnotation={async () => {}} onUpdateAnnotation={async () => {}} onDeleteAnnotation={async () => {}} />
  </section>;
}

function MediaUploadDragHarness() {
  const [items, setItems] = useState<PendingMedia[]>(() => [
    { id: "item-1", file: new File(["a"], "photo-1.png", { type: "image/png" }), previewUrl: samplePhotoUrl("#dbeafe", "1"), isVideo: false },
    { id: "item-2", file: new File(["b"], "photo-2.png", { type: "image/png" }), previewUrl: samplePhotoUrl("#dcfce7", "2"), isVideo: false },
  ]);
  return <section aria-label="Media upload drag harness" className="grid gap-3">
    <div id="outside-drop-peer" className="rounded border p-2 text-xs">Outside drop peer</div>
    <output id="upload-count">{items.length}</output>
    <MediaUploadField
      items={items}
      ticketTitle="Drag harness"
      onRenameAttachment={(id, name) => setItems(prev => prev.map(item => item.id === id ? { ...item, displayName: name } : item))}
      onItemsChange={setItems}
      onFilesAdded={files => setItems(prev => [
        ...prev,
        ...files.map((file, idx) => ({
          id: `added-${prev.length + idx + 1}`,
          file,
          previewUrl: samplePhotoUrl("#fef3c7", String(prev.length + idx + 1)),
          isVideo: file.type.startsWith("video/"),
        })),
      ])}
      onRequestRemove={target => setItems(prev => prev.filter(item => item.id !== target.id))}
    />
  </section>;
}

function CameraCaptureHarness() {
  const [open, setOpen] = useState(false);
  const [captured, setCaptured] = useState<string[]>([]);
  return <section aria-label="Camera capture harness" className="grid justify-items-start gap-2">
    <button type="button" onClick={() => setOpen(true)}>Open camera</button>
    <output id="captured-files">{captured.join(",")}</output>
    <CameraCaptureDialog
      open={open}
      onOpenChange={setOpen}
      onCapture={file => setCaptured(prev => [...prev, `${file.name}:${file.type}:${file.size}`])}
      onUseFilePicker={() => {}}
    />
  </section>;
}

function GroupedVideoHarness() {
  const [revision, setRevision] = useState(0);
  const [notes, setNotes] = useState<Annotation[]>([
    { id: "grp-pinned", label: 1, mediaIndex: 0, kind: "time", x: 0.3, y: 0.3, time: 0.2, text: "Pinned video note", createdAt: 1 },
    { id: "grp-time-only", label: 2, mediaIndex: 0, kind: "time", time: 0.22, text: "Timestamp-only grouped note", createdAt: 2 },
    { id: "grp-third", label: 3, mediaIndex: 0, kind: "time", time: 0.22, text: "Third grouped note", createdAt: 3 },
    { id: "solo-note", label: 4, mediaIndex: 0, kind: "time", x: 0.7, y: 0.7, time: 0.9, text: "Separate video note", createdAt: 4 },
  ]);
  const media = useMemo(
    () => [{ key: "vid-1", name: "pin-video.webm", size: 774, type: "video/webm", url: "/tests/browser/pin-video.webm" }],
    [],
  );
  useEffect(() => {
    window.__bumpMediaHarness = () => {
      setRevision(r => r + 1);
      setNotes(prev => prev.map(note => ({ ...note })));
    };
    return () => { delete window.__bumpMediaHarness; };
  }, []);
  return <section aria-label="Grouped video notes harness" className="grid gap-2">
    <output id="harness-revision">{revision}</output>
    <MediaViewer
      media={media}
      annotations={notes}
      onCreateAnnotation={async () => {}}
      onUpdateAnnotation={async () => {}}
      onDeleteAnnotation={async () => {}}
    />
  </section>;
}

function ThumbnailsHarness() {
  const media = useMemo(
    () => Array.from({ length: 8 }, (_, idx) => ({
      key: `thumb-${idx + 1}`,
      name: `Attachment ${idx + 1}.png`,
      size: 100,
      type: "image/png",
      url: samplePhotoUrl("#e2e8f0", String(idx + 1)),
    })),
    [],
  );
  return <section aria-label="Thumbnails harness" className="min-w-0">
    <MediaViewer
      media={media}
      annotations={[]}
      onCreateAnnotation={async () => {}}
      onUpdateAnnotation={async () => {}}
      onDeleteAnnotation={async () => {}}
    />
  </section>;
}

function CornerPinsHarness() {
  const media = useMemo(
    () => [{ key: "corner-1", name: "Corner photo.png", size: 100, type: "image/png", url: samplePhotoUrl("#e0f2fe", "Corners") }],
    [],
  );
  const notes = useMemo<Annotation[]>(() => [
    { id: "corner-tl", label: 1, mediaIndex: 0, kind: "point", x: 0, y: 0, text: "Top-left corner note", createdAt: 1 },
    { id: "corner-tr", label: 2, mediaIndex: 0, kind: "point", x: 1, y: 0, text: "Top-right corner note", createdAt: 2 },
    { id: "corner-bl", label: 3, mediaIndex: 0, kind: "point", x: 0, y: 1, text: "Bottom-left corner note", createdAt: 3 },
    { id: "corner-br", label: 4, mediaIndex: 0, kind: "point", x: 1, y: 1, text: "Bottom-right corner note", createdAt: 4 },
  ], []);
  return <section aria-label="Corner pins harness" className="min-w-0">
    <MediaViewer
      media={media}
      annotations={notes}
      onCreateAnnotation={async () => {}}
      onUpdateAnnotation={async () => {}}
      onDeleteAnnotation={async () => {}}
    />
  </section>;
}

function DelayedSaveHarness() {
  const [notes, setNotes] = useState<Annotation[]>([]);
  const [calls, setCalls] = useState(0);
  const pendingRef = useRef<{
    input: AnnotationDraftInput;
    resolve: () => void;
    reject: (reason?: unknown) => void;
  } | null>(null);
  const media = useMemo(
    () => [{ key: "delayed-1", name: "Delayed photo.png", size: 100, type: "image/png", url: samplePhotoUrl("#f1f5f9", "Save") }],
    [],
  );
  useEffect(() => {
    window.__mediaSaveControl = {
      calls: 0,
      resolveNext: () => {
        const pending = pendingRef.current;
        if (!pending) return;
        pendingRef.current = null;
        setNotes(prev => [
          ...prev,
          {
            id: `saved-${prev.length + 1}`,
            label: prev.length + 1,
            mediaIndex: pending.input.mediaIndex,
            kind: pending.input.kind,
            x: pending.input.x,
            y: pending.input.y,
            time: pending.input.time,
            text: pending.input.text,
            createdAt: Date.now(),
          },
        ]);
        pending.resolve();
      },
      rejectNext: (message: string) => {
        const pending = pendingRef.current;
        if (!pending) return;
        pendingRef.current = null;
        pending.reject(new Error(message));
      },
    };
    return () => { delete window.__mediaSaveControl; };
  }, []);
  return <section aria-label="Delayed note save harness" className="min-w-0">
    <output id="save-calls">{calls}</output>
    <MediaViewer
      media={media}
      annotations={notes}
      onCreateAnnotation={(input) => {
        if (window.__mediaSaveControl) window.__mediaSaveControl.calls += 1;
        setCalls(count => count + 1);
        return new Promise<void>((resolve, reject) => {
          pendingRef.current = { input, resolve, reject };
        });
      }}
      onUpdateAnnotation={async () => {}}
      onDeleteAnnotation={async () => {}}
    />
  </section>;
}

function Harness() {
  const { language, setLanguage } = useI18n();
  const only = params.get("case");
  return <main className="grid gap-6 p-2">
    <button type="button" className="justify-self-start" onClick={() => setLanguage(language === "en" ? "th" : "en")}>Language</button>
    {(!only || only === "switcher") && <Switcher />}
    {(!only || only === "rows") && <Rows />}
    {(!only || only === "notices") && <Notices />}
    {only === "removed-note" && <NoteChanges />}
    {only === "media-upload-drag" && <MediaUploadDragHarness />}
    {only === "camera-capture" && <CameraCaptureHarness />}
    {only === "viewer-grouped-video" && <GroupedVideoHarness />}
    {only === "viewer-thumbnails" && <ThumbnailsHarness />}
    {only === "viewer-corner-pins" && <CornerPinsHarness />}
    {only === "viewer-delayed-save" && <DelayedSaveHarness />}
    <AppToaster theme={document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<LanguageProvider><Harness /></LanguageProvider>);
