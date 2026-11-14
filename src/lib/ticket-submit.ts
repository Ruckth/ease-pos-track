/**
 * The single submit pipeline for new tickets, shared by the staff composer and
 * the customer three-step flow.
 *
 * Order matters: an upload intent is claimed first (idempotently), files upload
 * against that intent, and only then is the Ticket created. Unknown writes are
 * reconciled with the same input; only definitive rejections queue cleanup.
 */

import type { Id } from "@convex/_generated/dataModel";
import type { PendingMedia } from "@/lib/types";
import { pendingAnnotationsForCreate, type CreateAnnotationInput, type PendingAnnotation } from "@/lib/pending-annotations";
import type { MediaItem } from "@/lib/types";
import { readUploadCancelResponse } from "@/lib/upload-cancel";
import { uploadFiles } from "@/uploadthing";
import { definitiveUploadRejection, reconcileUploadWrite } from "../../shared/upload-receipt";
import { fileSignature } from "../../shared/media-policy";

export type UploadIntentHandle = {
  intentId: Id<"uploadIntents">;
  secret: string;
  ticketId?: Id<"tickets"> | undefined;
  uploadedFiles: MediaItem[];
};

export type TicketDraft = {
  title: string;
  description: string;
  items: PendingMedia[];
  annotations: PendingAnnotation[];
  /** Stable per-draft key so a retried submit reuses the same intent. */
  idempotencyKey: string;
};

export type SubmitTicketDeps = {
  token: string;
  createUploadIntent: (args: {
    token: string;
    idempotencyKey: string;
    files: Array<{ name: string; size: number; type: string }>;
  }) => Promise<UploadIntentHandle>;
  createTicket: (args: {
    token: string;
    requestId: string;
    title: string;
    description: string;
    media: MediaItem[];
    annotations: CreateAnnotationInput[];
    uploadIntentId: Id<"uploadIntents">;
    uploadIntentSecret: string;
  }) => Promise<unknown>;
  /** Injectable at the upload boundary so the zero-media path is regression tested. */
  uploadMedia?: typeof uploadFiles;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Reports a cleanup failure without masking the original error. */
  onCleanupError?: (error: unknown) => void;
  onRequestConflict?: () => void;
};

/** Queues guarded cleanup; this acknowledgement does not claim provider deletion. */
export async function requestUploadIntentCancel(
  token: string,
  intentId: Id<"uploadIntents">,
  secret: string,
) {
  const response = await fetch("/api/uploads/cancel", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ intentId, secret }),
  });
  return await readUploadCancelResponse(response);
}

export async function submitTicketDraft(deps: SubmitTicketDeps, draft: TicketDraft) {
  let activeIntent: { intentId: Id<"uploadIntents">; secret: string } | null = null;
  let creating = false;
  try {
    const intent = await reconcileUploadWrite(() => deps.createUploadIntent({
      token: deps.token,
      idempotencyKey: draft.idempotencyKey,
      files: draft.items.map((item) => ({
        name: item.file.name,
        size: item.file.size,
        type: item.file.type,
      })),
    }));
    // An attached intent supplies the original media for receipt validation;
    // it cannot bypass comparison of the original create input.
    if (!intent.ticketId) activeIntent = { intentId: intent.intentId, secret: intent.secret };
    deps.signal?.throwIfAborted();
    const reusable = [...intent.uploadedFiles];
    const media = draft.items.map(item => {
      const index = reusable.findIndex(uploaded => fileSignature(uploaded) === fileSignature(item.file));
      return index < 0 ? undefined : reusable.splice(index, 1)[0];
    });
    const missing = draft.items.flatMap((item, index) => media[index] ? [] : [{ file: item.file, index }]);
    const uploads = intent.ticketId || missing.length === 0 ? []
      : await (deps.uploadMedia ?? uploadFiles)("ticketMedia", {
          files: missing.map(item => item.file),
          input: { intentId: intent.intentId, secret: intent.secret },
          headers: { authorization: `Bearer ${deps.token}` },
          signal: deps.signal,
          onUploadProgress: ({ totalProgress }) => deps.onProgress?.(Math.round(totalProgress)),
        });

    uploads.forEach((uploaded, index) => {
      const raw = uploaded as typeof uploaded & { ufsUrl?: string; url?: string; type?: string };
      media[missing[index].index] = {
        key: uploaded.key,
        name: uploaded.name,
        size: uploaded.size,
        type: raw.type ?? missing[index].file.type,
        url: raw.ufsUrl ?? raw.url ?? "",
      };
    });

    const resolved = media.filter((item): item is MediaItem => item !== undefined);
    if (resolved.length !== draft.items.length) throw new Error("UPLOAD_INCOMPLETE");
    deps.signal?.throwIfAborted();
    creating = true;
    await reconcileUploadWrite(() => deps.createTicket({
      token: deps.token,
      requestId: draft.idempotencyKey,
      title: draft.title,
      description: draft.description,
      media: resolved,
      annotations: pendingAnnotationsForCreate(draft.items, draft.annotations),
      uploadIntentId: intent.intentId,
      uploadIntentSecret: intent.secret,
    }));
    activeIntent = null;
  } catch (error) {
    const abortedBeforeCreate = deps.signal?.aborted && !creating;
    const rejected = definitiveUploadRejection(error);
    if (rejected) deps.onRequestConflict?.();
    if (activeIntent && (abortedBeforeCreate || rejected)) {
      try {
        await requestUploadIntentCancel(deps.token, activeIntent.intentId, activeIntent.secret);
        if (abortedBeforeCreate && !rejected) deps.onRequestConflict?.();
      } catch (cleanupError) {
        deps.onCleanupError?.(cleanupError);
      }
    }
    throw error;
  }
}
