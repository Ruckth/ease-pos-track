// Browser harness for production UI components with explicit in-memory data:
// the Project switcher (three Projects to two), customer Ticket rows in all
// five states and two independent Undo notifications. No backend is involved.
import type { Id } from "../../convex/_generated/dataModel";
import type { Annotation, ProjectSummary, TicketStatus } from "../../src/lib/types";
import type { TicketSummary } from "../../shared/ticket-contracts";
import type { TicketAdapter } from "../../src/features/tickets/operations";
import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { LanguageProvider, useI18n } from "../../src/lib/i18n";
import { MediaViewer, type MediaViewerHandle } from "../../src/components/media-viewer";
import { ProjectSwitcher } from "../../src/components/project-controls";
import { CustomerTicketRow } from "../../src/features/tickets/customer-ticket-row";
import { ticketOperations } from "../../src/features/tickets/operations";
import { operationNotices } from "../../src/features/tickets/use-ticket-operations";
import { AppToaster } from "../../src/components/ui/sonner";
import "../../src/index.css";

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
  const target = (id: string) => ({ _id: id as Id<"tickets">, version: 0 });
  return <section aria-label="Notification harness" className="grid justify-items-start gap-2">
    <button type="button" onClick={() => { void operations.status(target("A"), "done"); void operations.status(target("B"), "waiting"); }}>Update two Tickets</button>
    <output id="undone">{undone.join(",")}</output>
  </section>;
}

function NoteChanges() {
  const viewer = useRef<MediaViewerHandle>(null);
  const [archived, setArchived] = useState(false);
  const [notes, setNotes] = useState<Annotation[]>([
    { id: "unavailable-note", label: 1, mediaIndex: 0, kind: "point", x: .4, y: .6, text: "Original note", createdAt: 1 },
  ]);
  const photoUrl = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="white"/></svg>');
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

function Harness() {
  const { language, setLanguage } = useI18n();
  const only = params.get("case");
  return <main className="grid gap-6 p-2">
    <button type="button" className="justify-self-start" onClick={() => setLanguage(language === "en" ? "th" : "en")}>Language</button>
    {(!only || only === "switcher") && <Switcher />}
    {(!only || only === "rows") && <Rows />}
    {(!only || only === "notices") && <Notices />}
    {only === "removed-note" && <NoteChanges />}
    <AppToaster theme={document.documentElement.classList.contains("dark") ? "dark" : "light"} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<LanguageProvider><Harness /></LanguageProvider>);
