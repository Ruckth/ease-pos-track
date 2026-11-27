import type { Id } from "@convex/_generated/dataModel";
import type { AnnotationDraftInput, AnnotationUpdateInput, PendingMedia } from "@/lib/types";
import { withoutPendingAnnotationsForMedia } from "@/lib/pending-annotations";
import { distinguishUploadFiles, submitTicketDraft, type SubmitTicketDeps, type TicketDraft } from "@/lib/ticket-submit";
import { MEDIA_POLICY } from "../../../shared/ticket-contracts";
import { validateFiles } from "../../../shared/media-policy";

export type DraftSnapshot = TicketDraft & { progress: number | null; error: unknown; retryLocked?: boolean };
type ImageCrop = { x: number; y: number; width: number; height: number };
type Resources = { prepareImage?: (file: File) => Promise<File>; createURL: (file: File) => string; revokeURL: (url: string) => void; requestKey: () => string; now: () => number };

/** A component-scoped, Project-bound owner. Disposal never deletes provider files. */
export class DisposableTicketDraft {
  private state: DraftSnapshot;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private submission: ReturnType<typeof submitTicketDraft> | null = null;
  private disposed = false;
  private retry?: { draft: TicketDraft; mediaEnabled?: boolean };
  private reviewedFiles = new WeakSet<File>();
  /** Set only after the create receipt is reconciled and cancellation checked. */
  private submittedId: Id<"tickets"> | undefined;
  get lastSubmittedId() { return this.submittedId; }
  constructor(readonly projectId: Id<"projects">, private resources: Resources = {
    prepareImage: async file => (await import("@/lib/optimize-image")).optimizeBrowserImage(file),
    createURL: file => URL.createObjectURL(file), revokeURL: url => URL.revokeObjectURL(url),
    requestKey: () => crypto.randomUUID(), now: () => Date.now(),
  }) {
    this.state = this.empty();
  }
  private empty(): DraftSnapshot {
    return { title: "", description: "", routingClassification: undefined, items: [], annotations: [], idempotencyKey: this.resources.requestKey(), progress: null, error: null, retryLocked: false };
  }
  getSnapshot = () => this.state;
  hasContent = () => {
    const { title, description, routingClassification, items, annotations } = this.state;
    return Boolean(title || description || routingClassification || items.length || annotations.length);
  };
  isSubmitting = () => this.state.progress !== null;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private change(patch: Partial<DraftSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private canEdit() { return !this.disposed && !this.controller && !this.retry; }
  setTitle = (title: string) => { if (this.canEdit()) this.change({ title }); };
  setDescription = (description: string) => { if (this.canEdit()) this.change({ description }); };
  setRoutingClassification = (routingClassification: TicketDraft["routingClassification"]) => {
    if (this.canEdit()) this.change({ routingClassification });
  };
  setError = (error: unknown) => this.change({ error });
  addFiles = (files: File[]) => {
    if (!this.canEdit()) return;
    this.change({ items: [...this.state.items, ...files.map(file => ({ id: this.resources.requestKey(), file, previewUrl: this.resources.createURL(file), isVideo: file.type.startsWith("video/") }))] });
  };
  reorder = (items: PendingMedia[]) => {
    if (!this.canEdit() || items.length !== this.state.items.length || new Set(items.map(item => item.id)).size !== items.length) return;
    const owned = new Map(this.state.items.map(item => [item.id, item]));
    if (items.every(item => owned.get(item.id) === item)) this.change({ items });
  };
  remove = (item: PendingMedia) => {
    if (!this.canEdit() || !this.state.items.includes(item)) return;
    this.resources.revokeURL(item.previewUrl);
    this.change({ items: this.state.items.filter(candidate => candidate !== item), annotations: withoutPendingAnnotationsForMedia(this.state.annotations, item.id) });
  };
  applyImageEdit = (expected: PendingMedia, file: File, { x, y, width, height }: ImageCrop): boolean => {
    if (!this.canEdit() || expected.isVideo || !this.state.items.includes(expected)) return false;
    if (!["image/png", "image/jpeg"].includes(file.type) || file.size <= 0 || file.size > MEDIA_POLICY.image.maxBytes) return false;
    const epsilon = Number.EPSILON * 4;
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0
      || x + width > 1 + epsilon || y + height > 1 + epsilon) return false;

    const annotations = [];
    for (const annotation of this.state.annotations) {
      if (annotation.mediaId !== expected.id || annotation.kind !== "point") {
        annotations.push(annotation);
        continue;
      }
      const { x: pinX, y: pinY } = annotation;
      if (pinX === undefined || pinY === undefined || !Number.isFinite(pinX) || !Number.isFinite(pinY)
        || pinX < x - epsilon || pinX > x + width + epsilon
        || pinY < y - epsilon || pinY > y + height + epsilon) return false;
      annotations.push({
        ...annotation,
        x: Math.min(1, Math.max(0, (pinX - x) / width)),
        y: Math.min(1, Math.max(0, (pinY - y) / height)),
      });
    }
    const extension = file.type === "image/png" ? "png" : "jpg";
    const reviewed = new File([file], `image-${this.resources.requestKey()}.${extension}`, { type: file.type });
    const previewUrl = this.resources.createURL(reviewed);
    this.reviewedFiles.add(reviewed);
    const replacement = { ...expected, file: reviewed, previewUrl };
    this.change({ items: this.state.items.map(item => item === expected ? replacement : item), annotations });
    this.resources.revokeURL(expected.previewUrl);
    return true;
  };
  addAnnotation = async (input: AnnotationDraftInput) => {
    if (!this.canEdit()) return false;
    const item = this.state.items[input.mediaIndex];
    if (!item) throw new Error("MEDIA_UNAVAILABLE");
    this.change({ annotations: [...this.state.annotations, { ...input, id: this.resources.requestKey(), mediaId: item.id, text: input.text.trim(), createdAt: this.resources.now() }] });
    return true;
  };
  updateAnnotation = async ({ annotationId, ...input }: AnnotationUpdateInput) => {
    if (this.canEdit()) this.change({ annotations: this.state.annotations.map(annotation => annotation.id === annotationId ? { ...annotation, ...input, text: input.text?.trim() ?? annotation.text } : annotation) });
  };
  deleteAnnotation = async (id: string) => {
    if (this.canEdit()) this.change({ annotations: this.state.annotations.filter(annotation => annotation.id !== id) });
  };
  private release() {
    if (this.controller && !this.controller.signal.aborted) this.controller.abort();
    this.controller = null;
    this.retry = undefined;
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
  cancelAndSettle = async () => {
    this.cancel();
    // submit records failures on the draft. Wait for its guarded cleanup, too.
    await this.submission?.catch(() => {});
  };
  async submit(deps: Omit<SubmitTicketDeps, "signal" | "onProgress" | "onRequestConflict" | "createTicket" | "reconciling"> & {
    createTicket: (args: Parameters<SubmitTicketDeps["createTicket"]>[0] & { projectId: Id<"projects"> }) => Promise<unknown>;
  }) {
    if (this.disposed || this.controller) return false;
    const controller = new AbortController();
    this.controller = controller;
    const previous = this.retry;
    let prepared = previous;
    const draft = this.state;
    this.change({ progress: 0, error: null });
    try {
      if (!prepared) {
        if (deps.mediaEnabled === false && (draft.items.length || draft.annotations.length)) throw new Error("PILOT_MEDIA_DISABLED");
        const items = [];
        for (const item of draft.items) {
          const prepare = !item.isVideo && !this.reviewedFiles.has(item.file) && this.resources.prepareImage;
          const file = prepare ? await prepare(item.file) : item.file;
          controller.signal.throwIfAborted();
          if (!item.isVideo && file.size > MEDIA_POLICY.image.maxBytes) throw new Error("IMAGE_TOO_LARGE");
          items.push({ ...item, file });
        }
        controller.signal.throwIfAborted();
        validateFiles(items.map(item => item.file));
        prepared = {
          mediaEnabled: deps.mediaEnabled,
          draft: {
            title: draft.title,
            description: draft.description,
            routingClassification: draft.routingClassification && { ...draft.routingClassification },
            idempotencyKey: draft.idempotencyKey,
            items: distinguishUploadFiles(items),
            annotations: draft.annotations.map(annotation => ({ ...annotation })),
          },
        };
      }
      this.retry = prepared;
      this.submission = submitTicketDraft({
        ...deps,
        mediaEnabled: prepared.mediaEnabled,
        reconciling: !!previous,
        createTicket: args => deps.createTicket({ ...args, projectId: this.projectId }),
        signal: controller.signal,
        onProgress: progress => { if (this.controller === controller) this.change({ progress }); },
        onRequestConflict: () => {
          if (this.controller !== controller) return;
          this.retry = undefined;
          this.change({ idempotencyKey: this.resources.requestKey(), retryLocked: false });
        },
      }, prepared.draft);
      const created = await this.submission;
      if (this.disposed || this.controller !== controller) return false;
      controller.signal.throwIfAborted();
      this.submittedId = typeof created === "string" ? created as Id<"tickets"> : undefined;
      this.release();
      this.change(this.empty());
      return true;
    } catch (error) {
      if (this.controller === controller) this.change({ error, retryLocked: !!this.retry });
      return false;
    } finally {
      this.submission = null;
      if (this.controller === controller) {
        if (!controller.signal.aborted) controller.abort();
        this.controller = null;
        this.change({ progress: null });
      }
    }
  }
}
