import { requireLocalFixtures } from "../local_fixtures";

type Profile = { displayName: string; pictureUrl?: string };
type BotInfo = Profile & { userId: string; basicId: string };
type WebhookTest = { success: boolean; statusCode?: number; reason?: string };
type PushResult = "accepted" | "unknown" | "rejected" | "limited";
const maxContentBytes = 8 * 1024 * 1024;

export const localLineFixtureToken = "local-line-fixture-token";

const fixtureTransport: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/summary")) return Response.json({ groupName: "Fixture group" });
  if (path.endsWith("/count")) return Response.json({ count: 3 });
  if (path.includes("/profile/")) return Response.json({ displayName: "Fixture user" });
  if (path.endsWith("/leave") || path.endsWith("/reply") || path.endsWith("/push")) return Response.json({});
  return new Response(null, { status: 404 });
};

export function createLine(token: string, transport: typeof fetch = fetch) {
  if (token === localLineFixtureToken) {
    requireLocalFixtures();
    transport = fixtureTransport;
  } else if (process.env.TICKET_LOCAL_PREVIEW === "true") {
    throw new Error("LINE_PREVIEW_REQUIRES_FIXTURE");
  }
  function send(host: "api.line.me" | "api-data.line.me", path: string, method: string, body?: object, retryKey?: string) {
    return transport(`https://${host}/v2/bot/${path}`, {
      method, redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }

  async function request<T>(path: string, method = "GET", body?: object, notFoundResult?: T): Promise<T> {
    try {
      const response = await send("api.line.me", path, method, body);
      if (response.status === 404 && notFoundResult !== undefined) return notFoundResult;
      if (response.status === 429) throw new Error("LINE_API_RATE_LIMITED");
      if (!response.ok) throw new Error();
      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.message === "LINE_API_RATE_LIMITED") throw error;
      throw new Error("LINE_API_REQUEST_FAILED");
    }
  }

  const chatPath = (kind: "group" | "room", id: string) => `${kind}/${encodeURIComponent(id)}`;
  return {
    info: () => request<BotInfo>("info"),
    setWebhook: (endpoint: string) => {
      if (!endpoint.startsWith("https://") || endpoint.length > 500) throw new Error("LINE_WEBHOOK_HTTPS_REQUIRED");
      return request("channel/webhook/endpoint", "PUT", { endpoint });
    },
    testWebhook: (endpoint: string) => request<WebhookTest>("channel/webhook/test", "POST", { endpoint }),
    webhookSettings: () => request<{ endpoint: string; active: boolean }>("channel/webhook/endpoint"),
    groupSummary: (id: string) => request<{ groupName: string; pictureUrl?: string }>(`${chatPath("group", id)}/summary`),
    count: (kind: "group" | "room", id: string) => request<{ count: number }>(`${chatPath(kind, id)}/members/count`),
    profile: (id: string) => request<Profile>(`profile/${encodeURIComponent(id)}`),
    // A repeated leave can find the bot already absent after an earlier successful request.
    leave: (kind: "group" | "room", id: string) => request<unknown>(`${chatPath(kind, id)}/leave`, "POST", undefined, null),
    reply: (replyToken: string, text: string) => request("message/reply", "POST", {
      replyToken, messages: [{ type: "text", text }],
    }),
    async getContent(messageId: string) {
      let response: Response;
      try {
        response = await send("api-data.line.me", `message/${encodeURIComponent(messageId)}/content`, "GET");
      } catch {
        throw new Error("LINE_CONTENT_UNAVAILABLE");
      }
      if (response.status === 404 || response.status === 410) throw new Error("LINE_CONTENT_EXPIRED");
      if (response.status !== 200 || !response.body) throw new Error("LINE_CONTENT_UNAVAILABLE");
      if (Number(response.headers.get("content-length")) > maxContentBytes) {
        await response.body.cancel().catch(() => {});
        throw new Error("LINE_CONTENT_TOO_LARGE");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxContentBytes) throw new Error("LINE_CONTENT_TOO_LARGE");
          chunks.push(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        if (error instanceof Error && error.message === "LINE_CONTENT_TOO_LARGE") throw error;
        throw new Error("LINE_CONTENT_UNAVAILABLE");
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, mimeType: response.headers.get("content-type") ?? undefined };
    },
    async push(to: string, text: string, retryKey: string): Promise<PushResult> {
      try {
        const response = await send("api.line.me", "message/push", "POST", {
          to, messages: [{ type: "text", text }],
        }, retryKey);
        if (response.ok || (response.status === 409 && response.headers.has("x-line-accepted-request-id"))) {
          return "accepted";
        }
        if (response.status === 429) return "limited";
        return response.status >= 500 ? "unknown" : "rejected";
      } catch {
        return "unknown";
      }
    },
  };
}
