import type { TicketRoutingClassification } from "../../shared/ticket-routing";
/**
 * The single submit pipeline for new tickets, shared by the staff composer and
 * the customer composer.
 *
 * For media-enabled deployments, an intent is claimed first (idempotently), files upload
 * against that intent, and only then is the Ticket created. Unknown writes are
 * reconciled with the same input; only definitive rejections queue cleanup.
 */

import type { Id } from "@convex/_generated/dataModel";
import type { PendingMedia } from "@/lib/types";
import { pendingAnnotationsForCreate, type CreateAnnotationInput, type PendingAnnotation } from "@/lib/pending-annotations";
import type { MediaItem } from "@/lib/types";
import { readUploadCancelResponse } from "@/lib/upload-cancel";
import type { uploadFiles } from "@/uploadthing";
import { definitiveUploadRejection, reconcileUploadWrite } from "../../shared/upload-receipt";
import { splitAttachmentName } from "@/lib/attachment-names";
import { MEDIA_POLICY } from "../../shared/ticket-contracts";
import { fileSignature } from "../../shared/media-policy";
import { errorCode } from "../../shared/errors";

type UploadIntentHandle = {
  intentId: Id<"uploadIntents">;
  secret: string;
  ticketId?: Id<"tickets"> | undefined;
  uploadedFiles: MediaItem[];
};

export type TicketDraft = {
  title: string;
  description: string;
  routingClassification?: TicketRoutingClassification;
  items: PendingMedia[];
  annotations: PendingAnnotation[];
  /** Stable per-draft key so a retried submit reuses the same intent. */
  idempotencyKey: string;
};

export type SubmitTicketDeps = {
  /** The Convex Auth access token, sent only to the upload server as a bearer. */
  token: string;
  mediaEnabled?: boolean;
  createUploadIntent: (args: {
    idempotencyKey: string;
    files: Array<{ name: string; size: number; type: string }>;
  }) => Promise<UploadIntentHandle>;
  createTicket: (args: {
    requestId: string;
    title: string;
    description: string;
    routingClassification?: TicketRoutingClassification;
    media: MediaItem[];
    annotations: CreateAnnotationInput[];
    uploadIntentId?: Id<"uploadIntents">;
    uploadIntentSecret?: string;
  }) => Promise<unknown>;
  /** Injectable at the upload boundary so the zero-media path is regression tested. */
  uploadMedia?: typeof uploadFiles;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  /** A previous attempt may have written against this request key. */
  reconciling?: boolean;
  /** Reports a cleanup failure without masking the original error. */
  onCleanupError?: (error: unknown) => void;
  onRequestConflict?: () => void;
};

/** Queues guarded cleanup; this acknowledgement does not claim provider deletion. */
async function requestUploadIntentCancel(
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

/** Give every ambiguous slot its own upload signature before declaring an intent. */
export function distinguishUploadFiles(items: PendingMedia[]): PendingMedia[] {
  const counts = new Map<string, number>();
  for (const { file } of items) {
    const signature = fileSignature(file);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  const used = new Set(counts.keys());
  return items.map((item, index) => {
    const { file } = item;
    if (counts.get(fileSignature(file)) === 1) return item;
    const { stem, extension } = item.name ? splitAttachmentName(file.name)
      : { stem: "", extension: file.name.match(/\.[a-z0-9]{1,10}$/i)?.[0] ?? "" };
    let revision = 0;
    let name: string;
    let signature: string;
    do {
      const suffix = `-${index + 1}-${++revision}`;
      const available = MEDIA_POLICY.maxFileNameLength - suffix.length;
      const retainedExtension = extension.length < available ? extension : "";
      const shortened = (stem || "attachment").slice(0, available - retainedExtension.length).replace(/[\uD800-\uDBFF]$/, "");
      name = (shortened || "a") + suffix + retainedExtension;
      signature = fileSignature({ name, size: file.size, type: file.type });
    } while (used.has(signature));
    used.add(signature);
    return { ...item, file: new File([file], name, { type: file.type, lastModified: file.lastModified }) };
  });
}

// createTicket emits these only on the new-Ticket path after receipt lookup.
const createErrorsWithoutReceipt = new Set([
  "REQUIRED_TICKET", "TITLE_TOO_LONG", "DESCRIPTION_TOO_LONG", "UNKNOWN_ROUTING_CODE",
  "COMMENT_TEXT_REQUIRED", "COMMENT_TOO_LONG", "INVALID_MEDIA_INDEX", "INVALID_ANNOTATION_KIND",
  "INVALID_ANNOTATION_POSITION", "INVALID_ANNOTATION_TIME", "INVALID_COMMENT_LABEL", "ANNOTATION_LIMIT_EXCEEDED",
  "IMAGE_VIDEO_ONLY", "MEDIA_LIMIT_EXCEEDED", "IMAGE_TOO_LARGE", "VIDEO_TOO_LARGE", "INVALID_FILE_METADATA",
  "INVALID_MEDIA_REFERENCE", "UPLOAD_INCOMPLETE",
]);

export async function submitTicketDraft(deps: SubmitTicketDeps, draft: TicketDraft) {
  let activeIntent: { intentId: Id<"uploadIntents">; secret: string } | null = null;
  let creating = false;
  try {
    deps.signal?.throwIfAborted();
    if (deps.mediaEnabled === false) {
      if (draft.items.length || draft.annotations.length) throw new Error("PILOT_MEDIA_DISABLED");
      return await reconcileUploadWrite(() => {
        deps.signal?.throwIfAborted();
        creating = true;
        return deps.createTicket({
          requestId: draft.idempotencyKey, title: draft.title,
          description: draft.description, media: [], annotations: [],
          ...(draft.routingClassification ? { routingClassification: draft.routingClassification } : {}),
        });
      });
    }
    const items = distinguishUploadFiles(draft.items);
    const intent = await reconcileUploadWrite(() => deps.createUploadIntent({
      idempotencyKey: draft.idempotencyKey,
      files: items.map((item) => ({
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
    const media = items.map(item => {
      const index = reusable.findIndex(uploaded => fileSignature(uploaded) === fileSignature(item.file));
      return index < 0 ? undefined : reusable.splice(index, 1)[0];
    });
    const missing = items.flatMap((item, index) => media[index] ? [] : [{ file: item.file, index }]);
    const uploads = intent.ticketId || missing.length === 0 ? []
      : await (deps.uploadMedia ?? (await import("@/uploadthing")).uploadFiles)("ticketMedia", {
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
    const created = await reconcileUploadWrite(() => deps.createTicket({
      requestId: draft.idempotencyKey,
      title: draft.title,
      description: draft.description,
      ...(draft.routingClassification ? { routingClassification: draft.routingClassification } : {}),
      media: resolved,
      annotations: pendingAnnotationsForCreate(draft.items, draft.annotations),
      uploadIntentId: intent.intentId,
      uploadIntentSecret: intent.secret,
    }));
    activeIntent = null;
    return created;
  } catch (error) {
    const abortedBeforeCreate = deps.signal?.aborted && !creating;
    const code = errorCode(error);
    // An earlier write stays uncertain until the server reaches its receipt check.
    const resolvedRetry = creating && code !== undefined
      && (createErrorsWithoutReceipt.has(code) || code === "REQUEST_ID_CONFLICT" || code === "TICKET_UNAVAILABLE");
    const rejected = definitiveUploadRejection(error) && (!deps.reconciling || resolvedRetry);
    if (rejected) deps.onRequestConflict?.();
    if (activeIntent && ((abortedBeforeCreate && !deps.reconciling) || rejected)) {
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
