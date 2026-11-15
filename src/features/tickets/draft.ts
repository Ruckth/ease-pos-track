import type { Id } from "@convex/_generated/dataModel";
import type { AnnotationDraftInput, AnnotationUpdateInput, PendingMedia } from "@/lib/types";
import { withoutPendingAnnotationsForMedia } from "@/lib/pending-annotations";
import { submitTicketDraft, type SubmitTicketDeps, type TicketDraft } from "@/lib/ticket-submit";

export type DraftSnapshot = TicketDraft & { progress: number | null; error: unknown };
type Resources = { createURL: (file: File) => string; revokeURL: (url: string) => void; requestKey: () => string; now: () => number };

/** A component-scoped, Project-bound owner. Disposal never deletes provider files. */
export class DisposableTicketDraft {
  private state: DraftSnapshot;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private disposed = false;
  constructor(readonly projectId: Id<"projects">, private resources: Resources = {
    createURL: file => URL.createObjectURL(file), revokeURL: url => URL.revokeObjectURL(url),
    requestKey: () => crypto.randomUUID(), now: () => Date.now(),
  }) {
    this.state = this.empty();
  }
  private empty(): DraftSnapshot {
    return { title: "", description: "", items: [], annotations: [], idempotencyKey: this.resources.requestKey(), progress: null, error: null };
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private change(patch: Partial<DraftSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  setTitle = (title: string) => { if (!this.controller) this.change({ title }); };
  setDescription = (description: string) => { if (!this.controller) this.change({ description }); };
  setError = (error: unknown) => this.change({ error });
  addFiles = (files: File[]) => {
    if (this.disposed || this.controller) return;
    this.change({ items: [...this.state.items, ...files.map(file => ({ id: this.resources.requestKey(), file, previewUrl: this.resources.createURL(file), isVideo: file.type.startsWith("video/") }))] });
  };
  reorder = (items: PendingMedia[]) => {
    if (this.controller || items.length !== this.state.items.length || new Set(items.map(item => item.id)).size !== items.length) return;
    const owned = new Map(this.state.items.map(item => [item.id, item]));
    if (items.every(item => owned.get(item.id) === item)) this.change({ items });
  };
  remove = (item: PendingMedia) => {
    if (this.controller || !this.state.items.includes(item)) return;
    this.resources.revokeURL(item.previewUrl);
    this.change({ items: this.state.items.filter(candidate => candidate !== item), annotations: withoutPendingAnnotationsForMedia(this.state.annotations, item.id) });
  };
  addAnnotation = async (input: AnnotationDraftInput) => {
    if (this.controller || this.disposed) return false;
    const item = this.state.items[input.mediaIndex];
    if (!item) throw new Error("MEDIA_UNAVAILABLE");
    this.change({ annotations: [...this.state.annotations, { ...input, id: this.resources.requestKey(), mediaId: item.id, text: input.text.trim(), createdAt: this.resources.now() }] });
    return true;
  };
  updateAnnotation = async ({ annotationId, ...input }: AnnotationUpdateInput) => {
    if (!this.controller) this.change({ annotations: this.state.annotations.map(annotation => annotation.id === annotationId ? { ...annotation, ...input, text: input.text?.trim() ?? annotation.text } : annotation) });
  };
  deleteAnnotation = async (id: string) => {
    if (!this.controller) this.change({ annotations: this.state.annotations.filter(annotation => annotation.id !== id) });
  };
  private release() {
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
    this.controller = null;
    for (const item of this.state.items) this.resources.revokeURL(item.previewUrl);
    this.state = { ...this.state, items: [], annotations: [] };
  }
  dispose = () => {
    if (this.disposed) return;
    this.release();
    this.disposed = true;
  };
  cancel = () => {
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
  };
  async submit(deps: Omit<SubmitTicketDeps, "signal" | "onProgress" | "onRequestConflict" | "createTicket"> & {
    createTicket: (args: Parameters<SubmitTicketDeps["createTicket"]>[0] & { projectId: Id<"projects"> }) => Promise<unknown>;
  }) {
    if (this.disposed || this.controller) return false;
    const controller = new AbortController();
    this.controller = controller;
    const draft = this.state;
    this.change({ progress: 0, error: null });
    try {
      await submitTicketDraft({ ...deps, createTicket: args => deps.createTicket({ ...args, projectId: this.projectId }),
        signal: controller.signal,
        onProgress: progress => { if (this.controller === controller) this.change({ progress }); },
        onRequestConflict: () => { if (this.controller === controller) this.change({ idempotencyKey: this.resources.requestKey() }); },
      }, draft);
      if (this.disposed || this.controller !== controller) return false;
      controller.signal.throwIfAborted();
      this.release();
      this.change(this.empty());
      return true;
    } catch (error) {
      if (this.controller === controller) this.change({ error });
      return false;
    } finally {
      if (this.controller === controller) {
        if (!controller.signal.aborted) controller.abort();
        this.controller = null;
        this.change({ progress: null });
      }
    }
  }
}
