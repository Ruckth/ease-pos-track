import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { Page } from "playwright";
import { api } from "../../convex/_generated/api";
import { baseURL, convex, copy, open, openHeaderMenu, seed, suiteBrowser } from "./harness";
import { capture } from "../../scripts/browser-evidence";

const browser = suiteBrowser();
after(browser.close);

async function routingDialog(page: Page) {
  await openHeaderMenu(page, copy("en", "queueMore"));
  await page.getByRole("menuitem", { name: "Ticket routing", exact: true }).click();
  return page.getByRole("dialog", { name: "Ticket routing" });
}

test("staff board loads full routing settings only when routing is opened", async () => {
  await capture("workflows", "staff routing query is on demand", async () => {
    let settingsSubscriptions = 0;
    const { context, page } = await open(await browser.get(), "staff", "en", async context => {
      context.on("page", page => page.on("websocket", socket => {
        if (!new URL(socket.url()).pathname.endsWith("/sync")) return;
        socket.on("framesent", ({ payload }) => {
          const message = JSON.parse(String(payload));
          if (message.type !== "ModifyQuerySet") return;
          settingsSubscriptions += message.modifications.filter((change: { type: string; udfPath?: string }) =>
            change.type === "Add" && change.udfPath === "ticket_routing:getSettings").length;
        });
      }));
    });
    try {
      await page.getByRole("dialog").getByRole("button", { name: copy("en", "closeDialog") }).click();
      await page.locator("#staff-ticket-results button[data-ticket-id]").first().waitFor();
      await page.getByRole("combobox", { name: "Assignment", exact: true }).waitFor();
      assert.equal(settingsSubscriptions, 0);
      const routing = await routingDialog(page);
      await routing.getByRole("button", { name: "Availability", exact: true }).waitFor();
      assert.equal(settingsSubscriptions, 1);
    } finally { await context.close(); }
  });
});

test("named staff use rules, review, Mine and manual holds while the customer sees only status", async () => {
  await capture("workflows", "named staff routing and customer privacy", async () => {
    const project = seed.projects[0];
    const token = seed.sessions[0];
    const settings = await convex.query(api.ticket_routing.getSettings, { token, projectId: project.id });
    assert.equal(settings?.owner, true);
    // Named staff from the seed, by durable staff ID.
    const directory = await convex.query(api.identity.listStaffDirectory, { token });
    const owner = directory.find(member => member.name === "Local Owner")!.staffId;
    const staffMember = directory.find(member => member.name === "Local Staff")!.staffId;
    await convex.mutation(api.ticket_routing.saveConfiguration, {
      token, projectId: project.id, expectedGeneration: settings!.policy.policyGeneration,
      areas: [{ code: "hardware", en: "Hardware", th: "ฮาร์ดแวร์", primary: [owner], fallback: [staffMember], active: true }],
      products: [{ code: "printer", en: "Printer", th: "เครื่องพิมพ์", meaning: "Receipt printer" }],
      symptoms: [{ code: "blank", en: "Blank receipt", th: "ใบเสร็จว่าง", meaning: "Blank paper" }],
      rules: [{ product: "printer", symptom: "blank", area: "hardware" }],
      intake: [owner], backup: staffMember,
    });
    const title = `Routing fixture ${crypto.randomUUID().slice(0, 8)}`;
    const customer = await open(await browser.get(), "customer", "th");
    const staff = await open(await browser.get(), "staff", "en");
    try {
      await customer.title.fill(title);
      const classification = customer.page.locator("summary").filter({ hasText: "ผลิตภัณฑ์และอาการ (ไม่บังคับ)" });
      const product = customer.page.getByRole("combobox", { name: "ผลิตภัณฑ์", exact: true });
      const symptom = customer.page.getByRole("combobox", { name: "อาการ", exact: true });
      await classification.waitFor();
      assert.equal(await product.isVisible(), false);
      assert.equal(await symptom.isVisible(), false);
      assert.equal(await customer.page.getByRole("checkbox", { name: "ให้เจ้าหน้าที่เลือกผู้รับผิดชอบเอง" }).isVisible(), true);
      await classification.press("Enter");
      await product.selectOption({ label: "เครื่องพิมพ์" });
      await symptom.selectOption({ label: "ใบเสร็จว่าง" });
      await classification.press("Enter");
      await classification.getByText("เครื่องพิมพ์ · ใบเสร็จว่าง", { exact: true }).waitFor();
      assert.equal(await product.isVisible(), false);
      await customer.page.getByRole("button", { name: copy("th", "submitTicket"), exact: true }).click();
      await customer.page.waitForURL(/ticket=/);
      await customer.page.getByRole("heading", { name: title }).waitFor();
      const ticket = new URL(customer.page.url()).searchParams.get("ticket");
      assert.ok(ticket);

      await staff.page.goto(`${baseURL}/staff?project=POS&view=queue`);
      await staff.page.getByRole("button", { name: "Ticket inbox", exact: true }).click();
      const inbox = staff.page.getByRole("dialog", { name: "Ticket inbox" });
      await inbox.getByRole("button").filter({ hasText: title }).filter({ hasText: "New Ticket for intake" }).click();
      await staff.page.waitForURL(url => url.searchParams.get("ticket") === ticket);
      const assignment = staff.page.getByRole("region", { name: "Assignment" });
      await assignment.getByText("Unassigned", { exact: true }).first().waitFor();
      await assignment.getByText("Review routing classification", { exact: true }).click();
      assert.equal(await assignment.getByRole("combobox", { name: "Product", exact: true }).inputValue(), "printer");
      await assignment.getByRole("button", { name: "Save classification" }).click();

      const queue = await routingDialog(staff.page);
      await queue.getByRole("button", { name: new RegExp(title) }).waitFor();
      await queue.getByRole("button", { name: "Accept", exact: true }).click();
      await queue.getByText("Assignment saved.", { exact: true }).waitFor();
      await staff.page.keyboard.press("Escape");
      await assignment.getByText("Local Owner · Hardware", { exact: true }).waitFor();
      await staff.page.getByRole("combobox", { name: "Assignment", exact: true }).selectOption("mine");
      await staff.page.locator("#staff-ticket-results").getByText(title, { exact: true }).first().waitFor();

      await assignment.getByRole("combobox", { name: "Assignee", exact: true }).selectOption({ label: "Local Staff" });
      await assignment.getByLabel("Hold routing", { exact: true }).check();
      await assignment.getByRole("button", { name: "Save assignment" }).click();
      await assignment.getByText("Local Staff · Hardware · Routing held", { exact: true }).waitFor();

      assert.equal(await customer.page.getByText(/Local Owner|Local Staff|ฮาร์ดแวร์/).count(), 0);
      assert.equal(await customer.page.getByRole("region", { name: "การมอบหมาย" }).count(), 0);
      assert.equal(customer.uploads() + staff.uploads(), 0);
      assert.deepEqual(customer.errors, []);
      assert.deepEqual(staff.errors, []);
    } finally {
      await staff.context.close();
      await customer.context.close();
    }
  });
});

test("staff settings history preserves the Project and saved Ticket draft", async () => {
  await capture("workflows", "staff settings history and saved Ticket draft", async () => {
    const { context, page, errors } = await open(await browser.get(), "staff");
    try {
      await page.goto(`${baseURL}/staff/settings/t3?project=POS`);
      const settings = page.getByRole("dialog", { name: copy("en", "connectT3"), exact: true });
      await settings.getByRole("button", { name: copy("en", "closeDialog") }).click();
      await page.waitForURL(url => url.pathname === "/staff");
      await page.getByRole("button", { name: copy("en", "newTicket"), exact: true }).click();
      await page.locator("#title").fill("Resume after T3 settings");
      await page.getByRole("dialog").getByRole("button", { name: copy("en", "closeDialog") }).click();
      await page.goBack();
      await settings.waitFor();
      assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
      await page.goForward();
      await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).click();
      assert.equal(await page.locator("#title").inputValue(), "Resume after T3 settings");
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
});
