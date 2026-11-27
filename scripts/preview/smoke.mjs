import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { origin } from "./router.mjs";

const labels = {
  en: { signIn: "Sign in", newTicket: "New Ticket", submit: "Submit Ticket" },
  th: { signIn: "เข้าสู่ระบบ", newTicket: "แจ้งปัญหา", submit: "ส่งเรื่อง" },
};

async function open(browser, width, endpoints, slot, language, use) {
  const { stable, cloud, site } = endpoints;
  const syncOrigin = cloud.replace("http:", "ws:");
  const context = await browser.newContext({ locale: language, viewport: { width, height: 900 }, serviceWorkers: "block" });
  try {
    const sockets = new Set();
    await context.routeWebSocket("**/*", socket => {
      if (new URL(socket.url()).origin === syncOrigin) {
        sockets.add(new URL(socket.url()).pathname);
        socket.connectToServer();
      } else socket.close();
    });
    await context.route("**/*", route => {
      const request = route.request();
      const target = new URL(request.url()).origin;
      if (target === stable && slot.probe) return route.continue({ headers: { ...request.headers(), "x-preview-probe": slot.probe } });
      if ([stable, cloud, site].includes(target)) return route.continue();
      return route.abort("blockedbyclient");
    });
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    await page.addInitScript(value => localStorage.setItem("ease-pos-tracking-language", value), language);
    await use(page, context);
    assert.ok([...sockets].some(path => path.endsWith("/sync")), "Browser must open the expected Convex WebSocket");
  } finally { await context.close(); }
}

export async function smoke({ port, slot, check, create = false }) {
  const stable = origin(port);
  const cloud = origin(slot.cloud);
  const site = origin(slot.site);
  const endpoints = { stable, cloud, site };
  const browser = await chromium.launch();
  try {
    for (const width of [1280, 390]) {
      await open(browser, width, endpoints, slot, "en", async (page, context) => {
        const search = new URLSearchParams({ project: "POS", ticket: slot.seedTickets[0] });
        const response = await page.goto(`${stable}/staff?${search}`);
        assert.equal(response?.headers()["x-track-ease-preview-sha"], slot.sha);
        assert.equal(response?.headers()["x-track-ease-preview"], slot.name);
        await page.waitForURL(url => url.pathname === "/staff/login");
        await page.getByRole("button", { name: "owner@local.test", exact: true }).press("Enter");
        await page.getByRole("dialog").getByRole("heading", { name: "Printer needs review", exact: true }).waitFor();
        if (check) await check({ page, context, width, ...endpoints, checkWrites: create });
      });
      const language = width === 390 ? "th" : "en";
      const text = labels[language];
      await open(browser, width, endpoints, slot, language, async page => {
        const button = name => page.getByRole("button", { name, exact: true }).first();
        const username = width === 390 ? "bob" : "alice";
        const initial = width === 390 ? "Ticket from Bob" : "Ticket from Alice";
        const search = new URLSearchParams({ project: "POS", ticket: slot.seedTickets[width === 390 ? 2 : 1] });
        await page.goto(`${stable}/customer?${search}`);
        await page.waitForURL(url => url.pathname === "/customer/login");
        await page.locator("#customer-username").fill(username);
        await page.locator("#customer-password").fill("local customer passphrase");
        await button(text.signIn).press("Enter");
        await page.getByRole("region", { name: initial, exact: true }).waitFor();
        if (!create) return;
        const title = `Preview portal receipt ${randomUUID().slice(0, 8)}`;
        await page.goto(`${stable}/customer?project=POS`);
        await button(text.newTicket).click();
        await page.locator("#customer-ticket-title").fill(title);
        await page.locator("#customer-ticket-description").fill("Synthetic portal submission from the shared preview.");
        await button(text.submit).click();
        try {
          await page.getByRole("region", { name: title, exact: true }).waitFor();
        } catch (error) {
          const alerts = await page.getByRole("alert").allTextContents();
          throw new Error(`Portal receipt missing at ${width}px on ${new URL(page.url()).pathname}: ${alerts.join(" · ")}`, { cause: error });
        }
      });
    }
  } finally { await browser.close(); }
}
