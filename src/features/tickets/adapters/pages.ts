import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { pageFormData } from "../../../../shared/ticket-pages";

export type TicketPage = NonNullable<ReturnType<typeof useTicketPages>["pages"]>[number];
export type PageUpload = { ticket: string; requestId: string; entry: string; files: Array<{ path: string; blob: Blob }> };

export function useTicketPages(token: string, id: Id<"tickets">) {
  return {
    pages: useQuery(api.pages.listTicketPages, { token, id }),
    target: useQuery(api.pages.publishTarget, { token }),
    revoke: useMutation(api.pages.revokeTicketPage),
  };
}

/**
 * Sends the bundle to the deployment's page route. Every failure surfaces a stable
 * code; a lost response is `PAGE_PUBLISH_UNKNOWN`, resolved by retrying the same key.
 */
export async function publishTicketPage(siteUrl: string, token: string, upload: PageUpload) {
  let response: Response;
  try {
    response = await fetch(`${siteUrl}/v1/tickets/${encodeURIComponent(upload.ticket)}/pages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": upload.requestId },
      body: pageFormData(upload.entry, upload.files),
    });
  } catch { throw new Error("PAGE_PUBLISH_UNKNOWN"); }
  const body = await response.json().catch(() => null) as { ok?: boolean; code?: string; url?: string } | null;
  if (!response.ok || !body?.ok || !body.url) {
    throw new Error(body?.code && /^[A-Z][A-Z_]+$/.test(body.code) ? body.code : "PAGE_PUBLISH_UNKNOWN");
  }
  return { url: body.url };
}
