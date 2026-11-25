import { requireLocalFixtures } from "../local_fixtures";

type Profile = { displayName: string; pictureUrl?: string };
type BotInfo = Profile & { userId: string; basicId: string };
type WebhookTest = { success: boolean; statusCode?: number; reason?: string };

export const localLineFixtureToken = "local-line-fixture-token";

const fixtureTransport: typeof fetch = async (input) => {
  const path = new URL(String(input)).pathname;
  if (path.endsWith("/summary")) return Response.json({ groupName: "Fixture group" });
  if (path.endsWith("/count")) return Response.json({ count: 3 });
  if (path.includes("/profile/")) return Response.json({ displayName: "Fixture user" });
  if (path.endsWith("/leave") || path.endsWith("/reply")) return Response.json({});
  return new Response(null, { status: 404 });
};

export function createLine(token: string, transport: typeof fetch = fetch) {
  if (token === localLineFixtureToken) {
    requireLocalFixtures();
    transport = fixtureTransport;
  }
  async function request<T>(path: string, method = "GET", body?: object, notFoundResult?: T): Promise<T> {
    try {
      const response = await transport(`https://api.line.me/v2/bot/${path}`, {
        method, redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
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
    groupSummary: (id: string) => request<{ groupName: string; pictureUrl?: string }>(`${chatPath("group", id)}/summary`),
    count: (kind: "group" | "room", id: string) => request<{ count: number }>(`${chatPath(kind, id)}/members/count`),
    profile: (id: string) => request<Profile>(`profile/${encodeURIComponent(id)}`),
    // A repeated leave can find the bot already absent after an earlier successful request.
    leave: (kind: "group" | "room", id: string) => request<unknown>(`${chatPath(kind, id)}/leave`, "POST", undefined, null),
    reply: (replyToken: string, text: string) => request("message/reply", "POST", {
      replyToken, messages: [{ type: "text", text }],
    }),
  };
}
