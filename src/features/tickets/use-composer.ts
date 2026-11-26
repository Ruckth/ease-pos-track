import type { ProjectSummary } from "@/lib/types";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { localizeError, useI18n } from "@/lib/i18n";
import { pendingAnnotationsForViewer, pendingMediaForViewer } from "@/lib/pending-annotations";
import { toast } from "sonner";
import { useDraftAdapter, useTicketCapabilities } from "./adapter";
import { useAccessToken } from "@/app/adapter";
import { DisposableTicketDraft } from "./draft";
import { useDraftGuard } from "./use-draft-guard";

const subscribeIdle = () => () => {};
const getFalse = () => false;

/** Project identity is captured when opening; hiding a composer preserves its draft. */
export function useComposer(project: ProjectSummary | null | undefined, logout: () => Promise<void>) {
  const [entry, setEntry] = useState<{ project: ProjectSummary; owner: DisposableTicketDraft } | null>(null);
  const [open, setOpen] = useState(false);
  const lifetime = useRef({ generation: 0, entry });
  useEffect(() => {
    const ownerLifetime = lifetime.current;
    const generation = ++ownerLifetime.generation;
    // StrictMode replays setup synchronously. Defer final disposal so that replay
    // cannot destroy a live draft; a genuine unmount still disposes exactly once.
    return () => {
      queueMicrotask(() => {
        if (generation === ownerLifetime.generation) ownerLifetime.entry?.owner.dispose();
      });
    };
  }, []);
  const subscribe = entry?.owner.subscribe ?? subscribeIdle;
  const hasDraft = useSyncExternalStore(subscribe, entry?.owner.hasContent ?? getFalse);
  const busy = useSyncExternalStore(subscribe, entry?.owner.isSubmitting ?? getFalse);
  const signOut = useDraftGuard(hasDraft, busy, async () => { await lifetime.current.entry?.owner.cancelAndSettle(); }, logout);
  function replace(next: typeof entry) {
    lifetime.current.entry?.owner.dispose();
    lifetime.current.entry = next;
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
    setOpen(next: boolean) { if (next || !busy) setOpen(next); },
    discard() { if (!busy) complete(); },
    complete,
  };
}

/** A consumer can remount without taking ownership of the draft's lifetime. */
export function useTicketDraft(owner: DisposableTicketDraft) {
  const { t } = useI18n();
  const adapter = useDraftAdapter();
  const mediaEnabled = useTicketCapabilities()?.mediaEnabled;
  // The upload server forwards this access token on a per-request Convex client.
  const accessToken = useAccessToken();
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot);
  const { items, annotations } = state;
  const viewerMedia = useMemo(() => pendingMediaForViewer(items), [items]);
  const viewerAnnotations = useMemo(() => pendingAnnotationsForViewer(items, annotations), [items, annotations]);
  const annotationCounts = useMemo(() => annotations.reduce<Record<string, number>>((counts, annotation) => {
    counts[annotation.mediaId] = (counts[annotation.mediaId] ?? 0) + 1;
    return counts;
  }, {}), [annotations]);
  return { ...state, owner, mediaEnabled, viewerMedia, viewerAnnotations, annotationCounts,
    error: state.error ? localizeError(state.error, t) : "",
    setTitle: owner.setTitle, setDescription: owner.setDescription, setItems: owner.reorder,
    setError: owner.setError,
    createPendingAnnotation: async (input: Parameters<typeof owner.addAnnotation>[0]) => {
      if (await owner.addAnnotation(input)) toast.success(t("pinAdded"));
    },
    updatePendingAnnotation: owner.updateAnnotation, deletePendingAnnotation: owner.deleteAnnotation,
    submit: () => owner.submit({ ...adapter, token: accessToken ?? "", mediaEnabled: mediaEnabled === true, onCleanupError: error => toast.error(localizeError(error, t)) }),
  };
}
