/**
 * The single submit pipeline for new tickets, shared by the staff composer and
 * the customer three-step flow.
 *
 * Order matters: an upload intent is claimed first (idempotently), files upload
 * against that intent, and only then is the ticket created. Any failure after
 * the intent exists cancels it so the uploaded blobs are cleaned up instead of
 * being orphaned.
 */

import type { Id } from "@convex/_generated/dataModel";
import type { PendingMedia } from "@/components/media-upload";
import { pendingAnnotationsForCreate, type CreateAnnotationInput, type PendingAnnotation } from "@/lib/pending-annotations";
import type { MediaItem } from "@/lib/types";
import { readUploadCancelResponse } from "@/lib/upload-cancel";
import { uploadFiles } from "@/uploadthing";

export type UploadIntentHandle = {
  intentId: Id<"uploadIntents">;
  secret: string;
  feedbackId?: Id<"feedback"> | undefined;
};

export type FeedbackDraft = {
  title: string;
  description: string;
  items: PendingMedia[];
  annotations: PendingAnnotation[];
  /** Stable per-draft key so a retried submit reuses the same intent. */
  idempotencyKey: string;
};

export type SubmitFeedbackDeps = {
  token: string;
  createUploadIntent: (args: {
    token: string;
    idempotencyKey: string;
    files: Array<{ name: string; size: number; type: string }>;
  }) => Promise<UploadIntentHandle>;
  createFeedback: (args: {
    token: string;
    title: string;
    description: string;
    media: MediaItem[];
    annotations: CreateAnnotationInput[];
    uploadIntentId: Id<"uploadIntents">;
    uploadIntentSecret: string;
  }) => Promise<unknown>;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** Reports a cleanup failure without masking the original error. */
  onCleanupError?: (error: unknown) => void;
};

/** Cancels an intent through the upload API, which also deletes stored files. */
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

export async function submitFeedbackDraft(deps: SubmitFeedbackDeps, draft: FeedbackDraft) {
  let activeIntent: { intentId: Id<"uploadIntents">; secret: string } | null = null;
  try {
    const intent = await deps.createUploadIntent({
      token: deps.token,
      idempotencyKey: draft.idempotencyKey,
      files: draft.items.map((item) => ({
        name: item.file.name,
        size: item.file.size,
        type: item.file.type,
      })),
    });
    // The intent was already turned into a ticket by an earlier attempt.
    if (intent.feedbackId) return;

    activeIntent = { intentId: intent.intentId, secret: intent.secret };
    const uploads = await uploadFiles("feedbackMedia", {
      files: draft.items.map((item) => item.file),
      input: { intentId: intent.intentId, secret: intent.secret },
      headers: { authorization: `Bearer ${deps.token}` },
      signal: deps.signal,
      onUploadProgress: ({ totalProgress }) => deps.onProgress?.(Math.round(totalProgress)),
    });

    const media: MediaItem[] = uploads.map((uploaded, index) => {
      const raw = uploaded as typeof uploaded & { ufsUrl?: string; url?: string; type?: string };
      return {
        key: uploaded.key,
        name: uploaded.name,
        size: uploaded.size,
        type: raw.type ?? draft.items[index]?.file.type ?? "",
        url: raw.ufsUrl ?? raw.url ?? "",
      };
    });

    await deps.createFeedback({
      token: deps.token,
      title: draft.title,
      description: draft.description,
      media,
      annotations: pendingAnnotationsForCreate(draft.items, draft.annotations),
      uploadIntentId: intent.intentId,
      uploadIntentSecret: intent.secret,
    });
    activeIntent = null;
  } catch (error) {
    if (activeIntent) {
      try {
        await requestUploadIntentCancel(deps.token, activeIntent.intentId, activeIntent.secret);
      } catch (cleanupError) {
        deps.onCleanupError?.(cleanupError);
      }
    }
    throw error;
  }
}
