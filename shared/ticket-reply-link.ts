export const MAX_TICKET_REPLY_LINK_LENGTH = 2048;

/** External links are stored as text and opened on demand. The app never fetches their contents. */
export function normalizeTicketReplyUrl(raw: string) {
  const input = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (!input || input.length > MAX_TICKET_REPLY_LINK_LENGTH || /[\s\u0000-\u001f\u007f-\u009f]/.test(input)) throw new Error("INVALID_LINK");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("INVALID_LINK"); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.href.length > MAX_TICKET_REPLY_LINK_LENGTH) {
    throw new Error("INVALID_LINK");
  }
  return url.href;
}
