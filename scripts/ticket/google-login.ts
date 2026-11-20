/**
 * Named staff sign-in for the CLI: the same Google start/complete adapter as
 * the browser, returning to a loopback listener. The deployment must allow the
 * loopback origin in AUTH_REDIRECT_ORIGINS (default port 4271).
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { platform } from "node:os";
import type { SessionTokens, TicketRemote } from "./remote";

export const DEFAULT_LOOPBACK_PORT = 4271;
const CODE_PARAM = "convexAuthCode";
const ERROR_PARAM = "convexAuthError";

function openInBrowser(url: string) {
  if (platform() === "darwin") spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true }).unref();
  // Only the provider URL is printed; it carries no credential.
  process.stderr.write(`Continue signing in with Google in your browser:\n${url}\n`);
}

export async function googleLoopbackSignIn(
  remote: Pick<TicketRemote, "startGoogle" | "completeGoogle">,
  url: string,
  options: { port?: number; timeoutMs?: number; open?: (url: string) => void } = {},
): Promise<SessionTokens | null> {
  const port = options.port ?? DEFAULT_LOOPBACK_PORT;
  const redirectTo = `http://127.0.0.1:${port}/`;
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  try {
    const { redirect, state } = await remote.startGoogle(url, redirectTo);
    const code = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SIGN_IN_TIMEOUT")), options.timeoutMs ?? 5 * 60_000);
      server.on("request", (request, response) => {
        const received = new URL(request.url ?? "/", redirectTo);
        if (received.pathname !== "/") { response.writeHead(404).end(); return; }
        const value = received.searchParams.get(CODE_PARAM);
        response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        response.end(value ? "Signed in. Return to the terminal. / เข้าสู่ระบบแล้ว กลับไปที่เทอร์มินัล" : "Sign-in did not finish. Return to the terminal.");
        clearTimeout(timer);
        if (value) resolve(value);
        else reject(new Error(received.searchParams.get(ERROR_PARAM) ? "SIGN_IN_FAILED" : "SIGN_IN_FAILED"));
      });
    });
    (options.open ?? openInBrowser)(redirect);
    return await remote.completeGoogle(url, await code, state);
  } finally {
    server.close();
  }
}

/** Disposable local backend: a seeded staff account instead of Google. */
export function isLoopbackDeployment(url: string) {
  try { return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname); } catch { return false; }
}
