import type { ProjectSummary } from "@/lib/types";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { localizeError, useI18n } from "@/lib/i18n";
import { pendingAnnotationsForViewer, pendingMediaForViewer } from "@/lib/pending-annotations";
import { toast } from "sonner";
import { useDraftAdapter } from "./adapter";
import { DisposableTicketDraft, type DraftSnapshot } from "./draft";
import { useDraftGuard } from "./use-draft-guard";

const idle: DraftSnapshot = { idempotencyKey: "", error: null, title: "", description: "", items: [], annotations: [], progress: null };
const subscribeIdle = () => () => {};
const getIdle = () => idle;

/** Project identity is captured when opening; hiding a composer preserves its draft. */
export function useComposer(project: ProjectSummary | null | undefined, logout: () => Promise<void>) {
  const [entry, setEntry] = useState<{ project: ProjectSummary; owner: DisposableTicketDraft } | null>(null);
  const [open, setOpen] = useState(false);
  const current = useRef(entry);
  const lifetime = useRef(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    // StrictMode replays setup synchronously. Defer final disposal so that replay
    // cannot destroy a live draft; a genuine unmount still disposes exactly once.
    return () => { queueMicrotask(() => { if (generation === lifetime.current) current.current?.owner.dispose(); }); };
  }, []);
  const state = useSyncExternalStore(entry?.owner.subscribe ?? subscribeIdle, entry?.owner.getSnapshot ?? getIdle);
  const busy = state.progress !== null;
  const hasDraft = Boolean(state.title || state.description || state.items.length || state.annotations.length);
  const signOut = useDraftGuard(hasDraft, busy, async () => { await current.current?.owner.cancelAndSettle(); }, logout);
  function replace(next: typeof entry) {
    current.current?.owner.dispose();
    current.current = next;
    setEntry(next);
  }
  function complete() { replace(null); setOpen(false); }
  return {
    owner: entry?.owner, project: entry?.project, open,
    busy, hasDraft, signOut,
    show() {
      if (project && (!entry || (!hasDraft && !busy && entry.project._id !== project._id))) {
        replace({ project, owner: new DisposableTicketDraft(project._id) });
      }
      if (entry || project) setOpen(true);
    },
    setOpen(next: boolean) { if (next || state.progress === null) setOpen(next); },
    discard() { if (!busy) complete(); },
    complete,
  };
}

/** A consumer can remount without taking ownership of the draft's lifetime. */
export function useTicketDraft(token: string, owner: DisposableTicketDraft) {
  const { t } = useI18n();
  const adapter = useDraftAdapter();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const { items, annotations } = state;
  const viewerMedia = useMemo(() => pendingMediaForViewer(items), [items]);
  const viewerAnnotations = useMemo(() => pendingAnnotationsForViewer(items, annotations), [items, annotations]);
  const annotationCounts = useMemo(() => annotations.reduce<Record<string, number>>((counts, annotation) => {
    counts[annotation.mediaId] = (counts[annotation.mediaId] ?? 0) + 1;
    return counts;
  }, {}), [annotations]);
  return { ...state, owner, viewerMedia, viewerAnnotations, annotationCounts,
    error: state.error ? localizeError(state.error, t) : "",
    setTitle: owner.setTitle, setDescription: owner.setDescription, setItems: owner.reorder,
    setError: owner.setError,
    createPendingAnnotation: async (input: Parameters<typeof owner.addAnnotation>[0]) => {
      if (await owner.addAnnotation(input)) toast.success(t("pinAdded"));
    },
    updatePendingAnnotation: owner.updateAnnotation, deletePendingAnnotation: owner.deleteAnnotation,
    submit: () => owner.submit({ ...adapter, token, onCleanupError: error => toast.error(localizeError(error, t)) }),
  };
}
