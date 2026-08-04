/**
 * Reading the upload-cancel API's answer.
 *
 * Kept in its own module so the rule can be unit tested without pulling in the
 * UploadThing browser client that the submit pipeline needs.
 */

/**
 * Accepts only a JSON acknowledgement, and throws a stable, localizable code
 * otherwise.
 *
 * A bare `response.ok` check is not enough: with the dev proxy missing or
 * misrouted, the Vite server answers `/api/uploads/cancel` with `200 text/html`
 * (index.html). That would look like a successful cleanup while the uploaded
 * blobs stay orphaned, so anything that is not JSON reporting `ok: true` is
 * treated as a failure.
 */
export async function readUploadCancelResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.trim());
  const body: unknown = isJson ? await response.json().catch(() => null) : null;
  const payload = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;

  if (!response.ok || !isJson || payload === null || payload.ok !== true) {
    const reported = payload && typeof payload.error === "string" ? payload.error : null;
    throw new Error(reported ?? "UPLOAD_CLEANUP_FAILED");
  }
  return { deleted: typeof payload.deleted === "number" ? payload.deleted : 0 };
}
