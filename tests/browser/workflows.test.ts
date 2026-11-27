import { expectAccessible } from "./a11y";
import { formatTicketNumber } from "../../shared/ticket-numbers";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import path from "node:path";
import { after } from "node:test";
import type { BrowserContext, Locator, Page, Request } from "playwright";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { newContext, redact } from "../../scripts/browser-evidence";
import { authStorageKeys, baseURL, hostedPageErrors, chooseProject, convex, copy, files, localIdentityAdmin, openHeaderMenu, projectSwitcher, suiteBrowser, workflowTest as test, open as openWith, seed, stats, type Language, LOCAL_CUSTOMER_PASSWORD } from "./harness";

const browsers = suiteBrowser();
after(() => browsers.close());
const open = async (role: "staff" | "customer", language?: Language, configure?: (context: BrowserContext) => Promise<void>) => openWith(await browsers.get(), role, language, configure);

const filterTrigger = (page: Page) => page.locator('[data-slot="ticket-filter-trigger"]');
const filterPanel = (page: Page) => page.locator('[data-slot="ticket-filter-panel"]');
async function openFilters(page: Page) {
  await filterTrigger(page).click();
  await filterPanel(page).waitFor();
}

async function closeFilters(page: Page) {
  await page.keyboard.press("Escape");
  await filterPanel(page).waitFor({ state: "hidden" });
}

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: operations health shows safe configuration, counts and diagnostic views`, async () => {
    const f = await open("staff", language);
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      await dialog.getByText(copy(language, "healthStorage"), { exact: true }).waitFor();
      assert.equal(await dialog.getByRole("table", { name: copy(language, "healthCounts") }).count(), 1);
      await f.page.setViewportSize({ width: 360, height: 740 });
      const trigger = dialog.locator('[data-slot="ticket-filter-trigger"]');
      for (const key of ["healthFailed", "healthPending", "healthExpired"] as const) {
        await trigger.click();
        const choice = filterPanel(f.page).getByRole("radio", { name: copy(language, key), exact: true });
        await choice.click();
        assert.equal(await choice.isChecked(), true);
        await closeFilters(f.page);
        assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
        await dialog.getByRole("heading", { name: copy(language, key), exact: true }).waitFor();
        assert.equal(await trigger.getAttribute("aria-label"), key === "healthFailed" ? copy(language, "ticketFilters") : copy(language, "ticketFiltersApplied", { count: 1 }));
        await dialog.getByText(copy(language, "healthPageHint"), { exact: true }).waitFor();
      }
      await trigger.click();
      await filterPanel(f.page).getByRole("button", { name: copy(language, "ticketFiltersClear") }).click();
      await closeFilters(f.page);
      await dialog.getByRole("heading", { name: copy(language, "healthFailed"), exact: true }).waitFor();
      assert.equal(await trigger.getAttribute("aria-label"), copy(language, "ticketFilters"));
      assert.doesNotMatch(await dialog.innerText(), /local-only-callback-fixture|https?:|UPLOADTHING_TOKEN|UPLOAD_CALLBACK_SECRET/);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("customer navigation does not expose staff health", async () => {
  const f = await open("customer");
  try {
    await f.page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    assert.equal(await f.page.getByRole("button", { name: copy("en", "healthTitle"), exact: true }).count(), 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); }
});

for (const language of ["en", "th"] as const) test(`customer ${language}: Ticket header fits in one phone row`, async () => {
  const { page, context } = await open("customer", language);
  try {
    await page.goto(`${baseURL}/customer?project=POS&ticket=${seed.tickets[1]}`);
    await page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).waitFor();
    const header = page.locator("main > header");
    const wordmark = header.getByText(copy(language, "appName"), { exact: true });
    const project = projectSwitcher(page, language);
    const inbox = header.getByRole("button", { name: copy(language, "ticketInbox"), exact: true });
    const account = header.getByRole("button", { name: copy(language, "customerQueueMore"), exact: true });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await wordmark.isVisible(), false);
      await project.getByText("POS", { exact: true }).waitFor();
      assert.equal(await project.innerText(), "POS");
      const toolbar = await header.boundingBox();
      assert.ok(toolbar && toolbar.height <= 64, `Header height at ${width}px: ${toolbar?.height}`);
      for (const control of [project, inbox, account]) {
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 44 && box.x >= 0 && box.x + box.width <= width);
        assert.ok(Math.abs(box.y + box.height / 2 - (toolbar.y + toolbar.height / 2)) <= 1);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await wordmark.waitFor();
    await project.getByText(/\(POS\)/).waitFor();
    assert.match(await project.innerText(), /\(POS\)/);
  } finally { await context.close(); }
});

for (const language of ["en", "th"] as const) test(`customer ${language}: phone filters preserve search and restore the linked status on Back`, async () => {
  const { page, context } = await open("customer", language);
  try {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`${baseURL}/customer?project=POS&filter=waiting&q=Printer`);
    const trigger = filterTrigger(page);
    await page.getByRole("button", { name: copy(language, "ticketFiltersApplied", { count: 1 }), exact: true }).waitFor();
    const indicator = trigger.locator('[data-slot="ticket-filter-indicator"]');
    assert.equal(await indicator.isVisible(), true);
    assert.equal(await indicator.innerText(), "");
    await trigger.press("Enter");
    const waiting = filterPanel(page).getByRole("radio", { name: copy(language, "customerQueueWaiting"), exact: true });
    assert.equal(await waiting.isChecked(), true);
    await waiting.press("ArrowDown");
    await page.waitForURL(url => url.searchParams.get("filter") === "done");
    const bounds = await filterPanel(page).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
    await filterPanel(page).getByRole("button", { name: copy(language, "ticketFiltersClear"), exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("filter") && url.searchParams.get("q") === "Printer");
    await closeFilters(page);
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    assert.equal(await trigger.getAttribute("aria-label"), copy(language, "ticketFilters"));
    await page.goBack();
    await page.waitForURL(url => url.searchParams.get("filter") === "done" && url.searchParams.get("q") === "Printer");
    await page.getByRole("button", { name: copy(language, "ticketFiltersApplied", { count: 1 }), exact: true }).waitFor();
  } finally { await context.close(); }
});

test("customer filter panel closes when resizing hides the list beside an open Ticket", async () => {
  const { page, context } = await open("customer");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator("button[data-ticket-id]").first().click();
    await page.waitForURL(url => url.searchParams.has("ticket"));
    await openFilters(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await filterPanel(page).waitFor({ state: "hidden" });
    await page.setViewportSize({ width: 1280, height: 800 });
    assert.equal(await filterTrigger(page).getAttribute("aria-expanded"), "false");
  } finally { await context.close(); }
});

test("customer search finds older Tickets and can include resolved Tickets", async () => {
  const { page, context, token, errors } = await open("customer");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    const query = page.getByLabel(copy("en", "customerQueueSearch"), { exact: true });
    const setStatus = async (key: "allTickets" | "customerQueueAllActive") => {
      await openFilters(page);
      await filterPanel(page).getByRole("radio", { name: new RegExp("^" + copy("en", key) + "(?:$|\\s)") }).click();
      await closeFilters(page);
    };
    const older = page.getByRole("button", { name: copy("en", "loadOlder"), exact: true });
    const rows = page.locator("button[data-ticket-id]");
    const projectId = seed.projects.find(project => project.key === "POS")!.id;
    const scope = { projectId, lifecycle: "active" as const };
    const resolved = await convex.query(api.tickets.searchTickets, { ...scope, token, status: "done", search: "Printer queue fixture" });
    const target = resolved.matches.find(ticket => ticket.title === "Printer queue fixture 4");
    assert.ok(target, "seeded older resolved Ticket");
    const reference = formatTicketNumber(target.ticketNumber, target.projectKey);
    const targetRow = page.locator(`button[data-ticket-id="${target._id}"]`);
    const noMatches = page.getByText(copy("en", "customerQueueSearchEmpty"), { exact: true });

    await setStatus("allTickets");
    await older.waitFor();
    assert.equal(await targetRow.count(), 0, "the resolved Ticket lies beyond the first page");
    await setStatus("customerQueueAllActive");
    await query.fill("quartz");
    await rows.filter({ hasText: "Printer calibration" }).waitFor();
    assert.equal(await rows.filter({ hasText: "quartz calibration" }).count(), 0, "the other customer's Ticket stays hidden");
    assert.equal(await older.count(), 0, "search has its own result cap");
    await query.fill("Printer queue fixture");
    await rows.nth(1).waitFor();
    const nextId = await rows.nth(1).getAttribute("data-ticket-id");
    await rows.first().click();
    await page.getByRole("button", { name: copy("en", "detailNext"), exact: true }).click();
    await page.waitForFunction(id => new URL(location.href).searchParams.get("ticket") === id, nextId);
    await page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();

    await query.fill(reference);
    await noMatches.waitFor();
    await page.getByRole("button", { name: copy("en", "customerQueueSearchAllStatuses"), exact: true }).click();
    await targetRow.waitFor();
    assert.equal(await filterTrigger(page).getAttribute("aria-label"), "Filters, 1 applied");
    assert.equal(await filterTrigger(page).evaluate(el => document.activeElement === el), true);
    assert.equal(new URL(page.url()).searchParams.get("filter"), "all");
    assert.equal(await query.inputValue(), reference);
    await targetRow.click();
    await page.getByRole("heading", { name: target.title, exact: true }).waitFor();
    await page.goBack();
    await page.waitForFunction(id => document.activeElement?.getAttribute("data-ticket-id") === id, target._id);
    assert.equal(await query.inputValue(), reference);

    const clear = page.getByRole("button", { name: copy("en", "clearSearch"), exact: true });
    const clearSize = await clear.boundingBox();
    assert.ok(clearSize && clearSize.width >= 44 && clearSize.height >= 44);
    await clear.press("Enter");
    await page.waitForURL(url => !url.searchParams.has("q"));
    assert.equal(await query.inputValue(), "");
    assert.equal(new URL(page.url()).searchParams.get("filter"), "all");
    assert.equal(await query.evaluate(input => input === document.activeElement), true);
    await clear.waitFor({ state: "hidden" });
    await older.waitFor();
    assert.equal(await rows.count(), 20, "clearing search restores the first browse page");
    await older.click();
    await page.waitForFunction(() => document.querySelectorAll("button[data-ticket-id]").length === 40);
    assert.equal(await targetRow.count(), 0, "the resolved Ticket lies beyond the first 40 rows");

    await query.fill(reference);
    await targetRow.waitFor();
    await clear.click();
    await older.waitFor();
    assert.equal(await rows.count(), 40, "clearing search restores the loaded browse pages");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const language of ["en", "th"] as const) test(`${language}: customer Ticket thread supports hosted pages and two-way replies`, async () => {
  const customer = await openWith(await browsers.get(), "customer", language, undefined, {
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true,
  });
  let staff: Awaited<ReturnType<typeof open>> | undefined;
  const name = `Conversation ${language} ${crypto.randomUUID()}`;
  const description = "The receipt printer disconnects after its first print.";
  const question = `Which connection does your printer use? ${language}`;
  const reply = `It uses Bluetooth. ${language}`;
  const replyBox = customer.page.getByLabel(copy(language, "replyLabel"), { exact: true });
  const customerSend = customer.page.getByRole("button", { name: copy(language, "sendReply"), exact: true });
  try {
    await customer.title.fill(name);
    await customer.page.locator("#customer-ticket-description").fill(description);
    await customer.page.getByRole("button", { name: copy(language, "submitTicket"), exact: true }).click();
    await customer.page.getByRole("dialog").waitFor({ state: "hidden" });
    await customer.page.getByRole("heading", { name, exact: true }).waitFor();
    const id = new URL(customer.page.url()).searchParams.get("ticket") as Id<"tickets">;
    assert.ok(id);

    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    const customerRow = customer.page.locator(`button[data-ticket-id="${id}"]`);
    assert.ok((await customerRow.getAttribute("aria-label"))?.includes(name));
    await customerRow.click();
    await customer.page.getByRole("heading", { name, exact: true }).waitFor();
    await customer.page.goBack();
    await customer.page.waitForFunction(ticket => !new URL(location.href).searchParams.has("ticket") && document.activeElement?.getAttribute("data-ticket-id") === ticket, id);
    await customerRow.click();
    await customer.page.getByText(copy(language, "noTicketMessages"), { exact: true }).waitFor();
    assert.equal(await customer.page.getByRole("button", { name: copy(language, "threadAttachPage"), exact: true }).count(), 0);
    const picker = customer.page.locator('[data-slot="ticket-reply-files"]');
    assert.equal(await picker.getAttribute("accept"), "image/*,video/*");
    await picker.setInputFiles({ name: "page.html", mimeType: "text/html", buffer: Buffer.from("<p>Page</p>") });
    await customer.page.getByRole("alert").filter({ hasText: copy(language, "imageVideoOnly") }).waitFor();
    await files(customer.page, "reply-photo.png", picker);
    const removePhoto = customer.page.getByRole("button", { name: copy(language, "removeFile", { name: "reply-photo.png" }), exact: true });
    await removePhoto.waitFor();
    await replyBox.fill("It also happens on our second register.");
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.click();
    assert.equal(await replyBox.inputValue(), "It also happens on our second register.");
    await removePhoto.click();
    await customerSend.click();
    await customer.page.getByText(copy(language, "replySent"), { exact: true }).waitFor();

    staff = await open("staff", language);
    await staff.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
    await staff.page.getByPlaceholder(copy(language, "search"), { exact: true }).fill(name);
    await staff.page.locator(`button[data-ticket-id="${id}"]`).click();
    const staffPanel = staff.page.getByRole("heading", { name, exact: true });
    await staffPanel.waitFor();
    const file = path.join(pageFixture, "reports/details.html");
    const publishName = copy(language, "publishPage");
    if (language === "th") {
      const pagesButton = staff.page.getByRole("button", { name: copy(language, "pagesTitle"), exact: true });
      await pagesButton.click();
      await publishFrom(staff.page.locator("body"), language, "chooseHtmlFile", file);
      await pagesButton.click();
    }
    const conversation = staff.page.getByRole("button", { name: copy(language, "ticketConversation"), exact: true });
    if (await conversation.getAttribute("aria-expanded") === "false") await conversation.click();
    await staff.page.getByText("It also happens on our second register.", { exact: true }).waitFor();
    const staffReply = staff.page.getByLabel(copy(language, "replyLabel"), { exact: true });
    const attach = staff.page.getByRole("button", { name: copy(language, "threadAttachPage"), exact: true });
    await staffReply.fill(question);
    await attach.click();
    if (language === "en") {
      await staff.page.getByRole("button", { name: publishName, exact: true }).click();
      const publisher = staff.page.getByRole("dialog", { name: publishName, exact: true });
      await publisher.getByLabel(copy(language, "chooseHtmlFile"), { exact: true }).setInputFiles(file);
      await publisher.getByRole("button", { name: publishName, exact: true }).click();
      await publisher.waitFor({ state: "hidden" });
      await staff.page.getByRole("button", { name: copy(language, "threadRemoveLink"), exact: true }).waitFor();
    }
    const [published] = await convex.query(api.pages.listTicketPages, { token: staff.token, id });
    assert.ok(published?.url.includes("/p/"));
    const hostedUrl = published.url;
    if (language === "th") {
      await staff.page.getByRole("combobox", { name: copy(language, "threadAttachPage"), exact: true }).selectOption(published._id);
    }
    await staff.page.getByLabel(copy(language, "threadRequestReply"), { exact: true }).check();
    await staff.page.getByRole("button", { name: copy(language, "sendQuestion"), exact: true }).click();
    await staff.page.getByText(copy(language, "questionSent"), { exact: true }).waitFor();
    assert.equal((await convex.query(api.tickets.getTicket, { token: staff.token, id }))?.status, "waiting");

    await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "feedNeedsReply"), { exact: true }).waitFor();
    assert.ok((await customerRow.locator("[data-ticket-excerpt]").innerText()).includes(question));
    if (language === "en") {
      for (let index = 0; index < 12; index++) {
        await convex.mutation(api.conversations.send, {
          token: staff.token, id, body: `Staff update ${index + 1}`, requestId: crypto.randomUUID(), expectedVersion: 0, requestReply: false,
        });
      }
    }
    await customerRow.click();
    if (language === "en") {
      await customer.page.locator("[data-message-id]").getByText("Staff update 12", { exact: true }).waitFor();
      await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor({ state: "hidden" });
      await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).click();
      await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
      await customer.page.getByRole("button", { name: copy(language, "loadOlderMessages"), exact: true }).click();
      await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).waitFor();
    }
    const descriptionBox = await customer.page.getByRole("article").getByText(description, { exact: true }).boundingBox();
    const questionBox = await customer.page.locator("[data-message-id]").getByText(question, { exact: true }).boundingBox();
    const composerBox = await replyBox.boundingBox();
    assert.ok(questionBox && composerBox && descriptionBox && descriptionBox.y < questionBox.y && questionBox.y < composerBox.y);
    await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).click();
    assert.equal(await replyBox.evaluate(input => input === document.activeElement), true);
    const sharedPage = customer.page.getByRole("link", { name: copy(language, "openPageNamed", { name: "details.html" }), exact: true });
    assert.equal(await sharedPage.getAttribute("href"), hostedUrl);
    if (language === "en") await expectAccessible(customer.page, "Customer Ticket thread");
    const [popup] = await Promise.all([customer.context.waitForEvent("page"), sharedPage.click()]);
    await popup.getByRole("heading", { name: "Fixture details", exact: true }).waitFor();
    await popup.close();

    await customer.page.getByRole("button", { name: copy(language, "threadQuoteLinkNamed", { name: "details.html" }), exact: true }).click();
    await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(input => input === document.activeElement), true);
    await replyBox.fill(reply);
    await customer.page.getByRole("button", { name: copy(language, "threadLink"), exact: true }).click();
    const address = customer.page.getByLabel(copy(language, "threadLinkAddress"), { exact: true });
    await address.press("Escape");
    assert.equal(await replyBox.inputValue(), reply, "Escape closes link entry and keeps the current reply");
    await customer.page.getByRole("button", { name: copy(language, "threadLink"), exact: true }).click();
    await address.fill("http://example.com/device");
    await customer.page.getByRole("button", { name: copy(language, "threadAddLink"), exact: true }).click();
    await customer.page.getByRole("alert").filter({ hasText: copy(language, "threadInvalidLink") }).waitFor();
    await address.fill("https://example.com/device");
    await customer.page.getByRole("button", { name: copy(language, "threadAddLink"), exact: true }).click();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.click();
    assert.equal(await replyBox.inputValue(), reply);
    await customer.page.getByText(copy(language, "threadQuoting", { quote: "details.html" }), { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "threadRemoveLink"), exact: true }).waitFor();
    await customerSend.click();
    await customer.page.getByText(copy(language, "replySent"), { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "threadAnswerQuestion"), exact: true }).waitFor({ state: "hidden" });
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "customerQueueYouReplied"), { exact: true }).waitFor();
    assert.equal(await customerRow.getByText(copy(language, "feedNeedsReply"), { exact: true }).count(), 0);
    await customerRow.click();
    await staff.page.getByText(reply, { exact: true }).waitFor();
    await staff.page.getByText(copy(language, "threadCustomerReplied"), { exact: true }).first().waitFor();
    const external = staff.page.getByRole("link", { name: copy(language, "threadOpenLinkNamed", { name: "example.com" }), exact: true });
    assert.equal(await external.getAttribute("href"), "https://example.com/device");
    assert.equal(await external.getAttribute("rel"), "noopener noreferrer");

    await staff.page.locator("[data-message-id]").filter({ hasText: reply }).getByRole("button").last().click();
    await staff.page.getByText(copy(language, "threadQuoting", { quote: reply }), { exact: true }).waitFor();
    await staffReply.fill("Thanks. I can reproduce this now.");
    await staff.page.getByRole("button", { name: copy(language, "sendReply"), exact: true }).click();
    await customer.page.getByText("Thanks. I can reproduce this now.", { exact: true }).waitFor();
    await customer.page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
    await customerRow.getByText(copy(language, "customerQueueYouReplied"), { exact: true }).waitFor();
    await customerRow.click();
    await replyBox.fill("I can test another version.");
    await customerSend.click();
    await staff.page.getByText("I can test another version.", { exact: true }).waitFor();

    if (language === "en") {
      const receipt = { name: "reply-photo.png", size: 128, type: "image/png", key: `fixture-${crypto.randomUUID()}`, url: "https://fixture.invalid/reply-photo.png" };
      const intent = await convex.mutation(api.uploads.createUploadIntent, {
        token: customer.token, idempotencyKey: crypto.randomUUID(), files: [{ name: receipt.name, size: receipt.size, type: receipt.type }],
      });
      await convex.mutation(api.uploads.recordUploadedFile, {
        callbackToken: "local-only-callback-fixture", intentId: intent.intentId, secret: intent.secret, file: receipt,
      });
      const writable = await convex.query(api.tickets.getTicket, { token: customer.token, id });
      assert.ok(writable);
      await convex.mutation(api.conversations.send, {
        token: customer.token, id, body: "", media: [receipt], requestId: crypto.randomUUID(),
        uploadIntentId: intent.intentId, uploadIntentSecret: intent.secret, expectedVersion: writable.version,
      });
      const media = customer.page.getByRole("button", { name: copy(language, "threadOpenAttachment", { name: receipt.name }), exact: true });
      await media.waitFor();
      assert.equal(await customer.page.getByRole("article").getByRole("button").count(), 0, "Reply media is not attributed to the opening post");
      await media.click();
      await customer.page.getByRole("button", { name: copy(language, "detailMedia", { count: 1 }), exact: true, expanded: true }).waitFor();
      await staff.page.getByRole("button", { name: copy(language, "threadOpenAttachment", { name: receipt.name }), exact: true }).waitFor();
    }

    if (language === "en") {
      await customer.page.getByRole("button", { name: copy(language, "loadOlderMessages"), exact: true }).click();
      await sharedPage.waitFor();
    }
    await convex.mutation(api.pages.revokeTicketPage, { token: staff.token, pageId: published._id });
    await customer.page.getByText(copy(language, "threadPageUnavailable"), { exact: true }).waitFor();
    assert.equal(await sharedPage.count(), 0);
    const current = await convex.query(api.tickets.getTicket, { token: staff.token, id });
    assert.ok(current);
    assert.equal(current.status, "waiting");
    await convex.mutation(api.tickets.updateTicketStatus, { token: staff.token, id, status: "done", expectedVersion: current.version });
    await customer.page.getByText(copy(language, "threadResolved"), { exact: true }).waitFor();
    assert.equal(await customerSend.count(), 0);
    assert.equal(customer.uploads() + staff.uploads(), 0);
    assert.deepEqual(customer.errors, []);
    assert.deepEqual(staff.errors, []);
  } finally { await staff?.context.close(); await customer.context.close(); }
});

test("customer thread quotes exact files, notes and saved video moments via keyboard and viewer, and hides internal urgency", async () => {
  const { readFileSync } = await import("node:fs");
  const pngBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2dIAAAAASUVORK5CYII=", "base64");
  const webmBytes = readFileSync(path.resolve(import.meta.dirname, "pin-video.webm"));
  const customer = await open("customer", "en", async context => {
    await context.route("https://fixture.invalid/**", route => {
      const url = route.request().url();
      if (url.endsWith(".webm")) return route.fulfill({ status: 200, contentType: "video/webm", body: webmBytes });
      return route.fulfill({ status: 200, contentType: "image/png", body: pngBytes });
    });
  });
  const staffToken = seed.sessions[0];
  const projectId = seed.projects.find(p => p.key === "POS")!.id;
  const title = `Evidence quotes ${crypto.randomUUID()}`;
  const photo = {
    key: `fixture-ev-img-${crypto.randomUUID()}`,
    name: "checkout-receipt.png",
    size: pngBytes.length,
    type: "image/png",
    url: "https://fixture.invalid/checkout-receipt.png",
  };
  const video = {
    key: `fixture-ev-vid-${crypto.randomUUID()}`,
    name: "till-print.webm",
    size: webmBytes.length,
    type: "video/webm",
    url: "https://fixture.invalid/till-print.webm",
  };
  try {
    const intent = await convex.mutation(api.uploads.createUploadIntent, {
      token: customer.token,
      idempotencyKey: crypto.randomUUID(),
      files: [photo, video].map(({ name, size, type }) => ({ name, size, type })),
    });
    for (const file of [photo, video]) {
      await convex.mutation(api.uploads.recordUploadedFile, {
        callbackToken: "local-only-callback-fixture",
        intentId: intent.intentId,
        secret: intent.secret,
        file,
      });
    }
    const id = await convex.mutation(api.tickets.createTicket, {
      token: customer.token,
      projectId,
      title,
      description: "Receipt total is short by 100.",
      requestId: crypto.randomUUID(),
      media: [photo, video],
      annotations: [
        { mediaIndex: 0, kind: "point", x: 0.7, y: 0.4, text: "MEMBER -100 printed twice" },
        { mediaIndex: 1, kind: "time", x: 0.5, y: 0.5, time: 4, text: "Printer pauses before second line" },
      ],
      uploadIntentId: intent.intentId,
      uploadIntentSecret: intent.secret,
    });
    const detail = await convex.query(api.tickets.getTicket, { token: customer.token, id });
    assert.ok(detail);
    const pointNote = detail.annotations.find(note => note.kind === "point")!;
    const momentNote = detail.annotations.find(note => note.kind === "time")!;
    // Staff updates internal urgency; customer history must not expose it.
    await convex.mutation(api.tickets.updateUrgencyScore, {
      token: staffToken, id, urgencyScore: 85, expectedVersion: detail.version,
    });

    await customer.page.goto(`${baseURL}/customer?project=POS&ticket=${id}`);
    await customer.page.getByRole("heading", { name: title, exact: true }).waitFor();
    const replyBox = customer.page.getByLabel(copy("en", "replyLabel"), { exact: true });
    const sendButton = customer.page.getByRole("button", { name: copy("en", "sendReply"), exact: true });

    // 1. Keyboard picker flow: Escape closes picker cleanly, selecting a note populates composer and returns focus.
    const citeButton = customer.page.getByRole("button", { name: copy("en", "threadCiteEvidence"), exact: true });
    await citeButton.click();
    const selector = customer.page.getByRole("combobox", { name: copy("en", "threadCiteEvidence"), exact: true });
    await selector.waitFor();
    await selector.press("Escape");
    await selector.waitFor({ state: "hidden" });
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);

    await citeButton.click();
    await selector.selectOption(`annotation:${pointNote.id}`);
    await customer.page.getByText(copy("en", "threadAboutNote", { file: photo.name, label: pointNote.label }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("Look at the duplicate discount line here.");
    await customer.page.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await customer.page.locator(`button[data-ticket-id="${id}"]`).click();
    await customer.page.getByText(copy("en", "threadAboutNote", { file: photo.name, label: pointNote.label }), { exact: true }).waitFor();
    assert.equal(await replyBox.inputValue(), "Look at the duplicate discount line here.");
    await sendButton.click();
    await customer.page.getByText("Look at the duplicate discount line here.", { exact: true }).waitFor();

    // Clicking the sent note quote opens MediaViewer and focuses the exact pin.
    const noteQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "Look at the duplicate discount line here." })
      .getByRole("button", { name: new RegExp(photo.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await noteQuoteButton.click();
    await customer.page.getByRole("button", { name: copy("en", "detailMedia", { count: 2 }), exact: true, expanded: true }).waitFor();
    await customer.page.getByRole("heading", { name: copy("en", "noteLabel", { number: pointNote.label }), exact: true }).waitFor();
    await customer.page.waitForFunction(pinId => document.activeElement?.getAttribute("data-pin-id") === pinId, pointNote.id);

    // 2. Quote a saved video moment directly from the annotation list, send, and jump back to it.
    await customer.page.getByRole("button", { name: copy("en", "threadQuoteMoment", { time: "0:04" }), exact: true }).first().click();
    await customer.page.getByText(copy("en", "threadAboutMoment", { file: video.name, time: "0:04" }), { exact: true }).waitFor();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("The pause happens right at four seconds.");
    await sendButton.click();
    await customer.page.getByText("The pause happens right at four seconds.", { exact: true }).waitFor();

    const momentQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "The pause happens right at four seconds." })
      .getByRole("button", { name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await momentQuoteButton.click();
    await customer.page.locator(`video[aria-label="${video.name}"]`).waitFor();
    await customer.page.getByRole("heading", {
      name: `${copy("en", "noteLabel", { number: momentNote.label })} · ${copy("en", "pinAtTime", { time: "0:04" })}`,
      exact: true,
    }).waitFor();

    // 3. Quote the exact file from MediaViewer toolbar and verify sent file quote focuses it.
    await customer.page.getByRole("button", { name: copy("en", "threadQuoteFile"), exact: true }).click();
    assert.equal(await replyBox.evaluate(el => el === document.activeElement), true);
    await replyBox.fill("Sharing this video file directly.");
    await sendButton.click();
    const fileQuoteButton = customer.page.locator("[data-message-id]")
      .filter({ hasText: "Sharing this video file directly." })
      .getByRole("button", { name: new RegExp(video.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await fileQuoteButton.waitFor();
    await fileQuoteButton.click();
    await customer.page.locator(`video[aria-label="${video.name}"]`).waitFor();

    // 4. Soft-deleting the photo note switches the sent quote safely to unavailable without leaking deleted text.
    const latest = (await convex.query(api.tickets.getTicket, { token: customer.token, id }))!;
    await convex.mutation(api.annotations.removeAnnotation, {
      token: customer.token, id, expectedVersion: latest.version, annotationId: pointNote.id,
    });
    await customer.page.getByText(copy("en", "threadQuotedNoteUnavailable"), { exact: true }).waitFor();
    assert.equal(await noteQuoteButton.count(), 0);

    // 5. Customer Recent history excludes internal urgency changes.
    await customer.page.getByRole("button", { name: copy("en", "detailHistory"), exact: true }).click();
    await customer.page.getByText(copy("en", "actionCreated"), { exact: true }).waitFor();
    assert.equal(await customer.page.getByText(copy("en", "actionUrgencyChanged"), { exact: true }).count(), 0);
    assert.equal(customer.uploads(), 0);
    assert.deepEqual(customer.errors, []);
  } finally {
    await customer.context.close();
  }
});

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: purge requeue requires confirmation and cancellation sends no mutation`, async () => {
    // Exercise the real health UI with a failed-job transport fixture; never schedule deletion.
    const f = await open("staff", language, async context => {
      await context.route("**/src/features/operations/adapters/health.ts", route => route.fulfill({
        contentType: "application/javascript",
        body: `window.healthRequeues = [];
          export const useHealth = () => ({ counts: {}, oldestPendingAt: null,
            configuration: { uploadThingToken: false, callbackSecret: true, mediaCleanupEnabled: false } });
          export const useJobDiagnostics = () => ({ status: "Exhausted", loadMore() {},
            results: [{ jobId: "fake-purge", kind: "ticket_purge", state: "failed", attempt: 0, maxAttempts: 8,
              availableAt: 1794614400000, lastOutcome: "ownership_conflict", purgeBlocked: true }],
            requeue: async args => { window.healthRequeues.push(args); return true; } });`,
      }));
    });
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      const requeue = dialog.getByRole("button", { name: copy(language, "healthRequeue"), exact: true });
      const prompts: string[] = [];
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.dismiss(); });
      await requeue.click();
      const calls = () => f.page.evaluate(() => (window as unknown as { healthRequeues: unknown[] }).healthRequeues);
      assert.deepEqual(await calls(), []);
      f.page.once("dialog", async prompt => { prompts.push(prompt.message()); await prompt.accept(); });
      await requeue.click();
      await f.page.getByText(copy(language, "healthRequeued"), { exact: true }).waitFor();
      assert.deepEqual(await calls(), [{ jobId: "fake-purge" }]);
      assert.deepEqual(prompts, [copy(language, "healthPurgeConfirm"), copy(language, "healthPurgeConfirm")]);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

for (const language of ["en", "th"] as const) {
  test(`staff ${language}: operations health stays compact and unclipped across phone, sm and desktop viewports`, async () => {
    // Exercise populated counts, diagnostic states and paging with a transport fixture; never schedule deletion.
    const f = await open("staff", language, async context => {
      await context.route("**/src/features/operations/adapters/health.ts", route => route.fulfill({
        contentType: "application/javascript",
        body: `window.healthLoadMore = [];
          const counts = {
            "cancellation:pending": 4, "cancellation:running": 2, "cancellation:completed": 12, "cancellation:failed": 1, "cancellation:superseded": 0,
            "intent_expiry:pending": 3, "intent_expiry:running": 1, "intent_expiry:completed": 8, "intent_expiry:failed": 0, "intent_expiry:superseded": 0,
            "rejected_upload:pending": 2, "rejected_upload:running": 0, "rejected_upload:completed": 5, "rejected_upload:failed": 1, "rejected_upload:superseded": 0,
            "ticket_purge:pending": 1, "ticket_purge:running": 1, "ticket_purge:completed": 3, "ticket_purge:failed": 1, "ticket_purge:superseded": 2,
          };
          const byView = {
            failed: [
              { jobId: "f-cancel", kind: "cancellation", state: "failed", attempt: 3, maxAttempts: 8, availableAt: 1795700400000, lastOutcome: "failed_permanent", exhausted: false, purgeBlocked: false },
              { jobId: "f-purge", kind: "ticket_purge", state: "failed", attempt: 8, maxAttempts: 8, availableAt: 1795700400000, lastOutcome: "ownership_conflict", exhausted: true, purgeBlocked: true },
            ],
            pending: [
              { jobId: "p-expiry", kind: "intent_expiry", state: "pending", attempt: 1, maxAttempts: 8, availableAt: 1795700460000, lastOutcome: "failed_retryable", exhausted: false, purgeBlocked: false },
            ],
            expired: [
              { jobId: "e-cancel", kind: "cancellation", state: "running", attempt: 2, maxAttempts: 8, availableAt: 1795700400000, leaseExpiresAt: 1795701180000, exhausted: false, purgeBlocked: false },
            ],
          };
          export const useHealth = () => ({ counts, oldestPendingAt: 1795698180000,
            configuration: { uploadThingToken: false, callbackSecret: true, mediaCleanupEnabled: false } });
          export const useJobDiagnostics = view => ({ status: "CanLoadMore",
            loadMore(count) { window.healthLoadMore.push({ view, count }); },
            results: byView[view] ?? [],
            requeue: async () => true });`,
      }));
    });
    try {
      await f.page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await openHeaderMenu(f.page, copy(language, "queueMore"));
      await f.page.getByRole("menuitem", { name: copy(language, "healthTitle"), exact: true }).click();
      const dialog = f.page.getByRole("dialog", { name: copy(language, "healthTitle"), exact: true });
      const table = dialog.getByRole("table", { name: copy(language, "healthCounts") });
      await table.waitFor();

      for (const viewport of [
        { width: 320, height: 568 },
        { width: 360, height: 740 },
        { width: 390, height: 844 },
        { width: 640, height: 800 },
        { width: 768, height: 800 },
        { width: 1280, height: 900 },
      ]) {
        await f.page.setViewportSize(viewport);
        const layout = await dialog.evaluate(el => {
          const tableEl = el.querySelector("table")!;
          const wrap = tableEl.parentElement!;
          const dialogRect = el.getBoundingClientRect();
          const cells = [...tableEl.querySelectorAll("td")];
          const maxCellRight = Math.max(...cells.map(cell => cell.getBoundingClientRect().right));
          return {
            tableDisplay: getComputedStyle(tableEl).display,
            docOverflow: document.documentElement.scrollWidth - window.innerWidth,
            dialogOverflow: el.scrollWidth - el.clientWidth,
            tableOverflow: wrap.scrollWidth - wrap.clientWidth,
            cellsBeyondDialog: maxCellRight - dialogRect.right,
            columnHeaders: tableEl.querySelectorAll('[role="columnheader"]').length,
            rowHeaders: tableEl.querySelectorAll('[role="rowheader"]').length,
            cells: cells.length,
          };
        });
        assert.equal(layout.tableDisplay, viewport.width >= 768 ? "table" : "block");
        assert.ok(layout.docOverflow <= 0, `${language} ${viewport.width}px: document overflow ${layout.docOverflow}`);
        assert.ok(layout.dialogOverflow <= 0, `${language} ${viewport.width}px: dialog overflow ${layout.dialogOverflow}`);
        assert.ok(layout.tableOverflow <= 0, `${language} ${viewport.width}px: table wrapper overflow ${layout.tableOverflow}`);
        assert.ok(layout.cellsBeyondDialog <= 1, `${language} ${viewport.width}px: cell extends past dialog by ${layout.cellsBeyondDialog}`);
        assert.equal(layout.columnHeaders, 6);
        assert.equal(layout.rowHeaders, 4);
        assert.equal(layout.cells, 20);
      }

      // Phone compactness: on a 390x844 phone, the Diagnostics heading and filter stay above the fold.
      await f.page.setViewportSize({ width: 390, height: 844 });
      const failedHeading = dialog.getByRole("heading", { name: copy(language, "healthFailed"), exact: true });
      const trigger = dialog.locator('[data-slot="ticket-filter-trigger"]');
      const headingBox = (await failedHeading.boundingBox())!;
      const triggerBox = (await trigger.boundingBox())!;
      assert.ok(headingBox.y + headingBox.height <= 844, `${language} 390x844: diagnostics heading sits above the fold`);
      assert.ok(triggerBox.y + triggerBox.height <= 844 && triggerBox.height >= 44 && triggerBox.width >= 44, `${language} 390x844: filter button is touch-sized above the fold`);

      // Narrow phone failed card: Requeue stacks below full-width text without crushing metadata/warnings.
      await f.page.setViewportSize({ width: 320, height: 568 });
      const blockedItem = dialog.locator("ul > li").nth(1);
      await blockedItem.scrollIntoViewIfNeeded();
      await blockedItem.getByText(copy(language, "healthPurgeBlocked"), { exact: true }).waitFor();
      await blockedItem.getByText(copy(language, "healthExhausted"), { exact: true }).waitFor();
      const cardMetrics = await blockedItem.evaluate(el => {
        const textBlock = el.firstElementChild!.getBoundingClientRect();
        const button = el.querySelector("button")!.getBoundingClientRect();
        const style = getComputedStyle(el);
        const innerWidth = el.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        return { textWidthRatio: textBlock.width / innerWidth, buttonBelowText: button.top >= textBlock.bottom - 1, buttonHeight: button.height };
      });
      assert.ok(cardMetrics.textWidthRatio >= 0.9, `${language} 320px: job text spans full card width (${cardMetrics.textWidthRatio.toFixed(2)})`);
      assert.equal(cardMetrics.buttonBelowText, true, `${language} 320px: Requeue stacks below text`);
      assert.ok(cardMetrics.buttonHeight >= 44, `${language} 320px: Requeue keeps 44px touch height`);

      // Filter popover fits within 320px and switches to populated Pending and Expired views; paging fires loadMore(25).
      const loadMore = dialog.getByRole("button", { name: copy(language, "loadOlder"), exact: true });
      await loadMore.scrollIntoViewIfNeeded();
      assert.ok((await loadMore.boundingBox())!.height >= 44);
      await loadMore.click();
      await trigger.scrollIntoViewIfNeeded();
      await trigger.click();
      const panel = filterPanel(f.page);
      await panel.waitFor();
      const panelBox = (await panel.boundingBox())!;
      assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 320.5, `${language} 320px: filter popover fits viewport`);
      await panel.getByRole("radio", { name: copy(language, "healthPending"), exact: true }).click();
      await closeFilters(f.page);
      await dialog.getByText(copy(language, "healthRetry"), { exact: true }).waitFor();
      await trigger.click();
      await panel.getByRole("radio", { name: copy(language, "healthExpired"), exact: true }).click();
      await closeFilters(f.page);
      await dialog.getByRole("heading", { name: copy(language, "healthExpired"), exact: true }).waitFor();
      const loadCalls = await f.page.evaluate(() => (window as unknown as { healthLoadMore: unknown[] }).healthLoadMore);
      assert.deepEqual(loadCalls, [{ view: "failed", count: 25 }]);
      assert.deepEqual(f.errors, []);
      assert.equal(f.uploads(), 0);
    } finally { await f.context.close(); }
  });
}

test("customer sign-in masks a wrong password, then admits the named customer through the real form", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[1] });
    await page.goto(`${baseURL}/customer?${search}`);
    await page.waitForURL(url => url.pathname === "/customer/login" && !!url.searchParams.get("redirect"));
    await page.locator("#customer-username").fill("alice");
    await page.locator("#customer-password").fill("wrong customer passphrase");
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByRole("alert").waitFor();
    await page.locator("#customer-password").fill(LOCAL_CUSTOMER_PASSWORD);
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    await page.getByRole("region", { name: "Ticket from Alice", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[1]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/customer/login?redirect=${encodeURIComponent("/staff?project=POS")}`);
    await page.waitForURL(url => url.pathname === "/customer" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("redirect"), false);
    assert.equal(await page.locator("#customer-password").count(), 0);
  } finally { await context.close(); }
});

test("staff invitation survives a same-tab Google redirect without entering its return URL", async () => {
  const context = await newContext(await browsers.get());
  const secret = "synthetic-invitation-return-fixture";
  try {
    let observe!: (url: string) => void;
    const started = new Promise<string>(resolve => { observe = resolve; });
    await context.routeWebSocket(url => url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.udfPath === "auth:startSignInWithClerk") {
          observe(message.args[0].redirectTo);
          return;
        }
        server.send(raw);
      });
      server.onMessage(raw => socket.send(raw));
    });
    const page = await context.newPage();
    await page.goto(baseURL + "/staff/invite#invite=" + secret);
    const google = page.getByRole("button", { name: /Clerk/ }).first();
    const [returnURL] = await Promise.all([started, google.click()]);
    assert.equal(returnURL, new URL("/staff/invite", baseURL).href);
    await page.goto(returnURL);
    await google.waitFor();
    assert.equal(new URL(page.url()).hash, "");
  } finally { await context.close(); }
});

test("staff sign-in offers Google, and the local test provider admits a seeded Owner", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[0] });
    await page.goto(`${baseURL}/staff?${search}`);
    await page.waitForURL(url => url.pathname === "/staff/login" && !!url.searchParams.get("redirect"));
    await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).waitFor();
    await page.getByRole("button", { name: "owner@local.test", exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Printer needs review", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[0]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/staff/login?redirect=${encodeURIComponent("/customer?project=APP")}`);
    await page.waitForURL(url => url.pathname === "/staff" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("redirect"), false);
    assert.equal(await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).count(), 0);
  } finally { await context.close(); }
});

test("staff filter badge counts URL scopes and clears them together while preserving search", async () => {
  const { page, context } = await open("staff");
  try {
    await page.goto(`${baseURL}/staff?project=POS&view=queue&filter=new&assignment=mine&q=Printer`);
    const trigger = filterTrigger(page);
    await page.getByRole("button", { name: "Filters, 2 applied", exact: true }).waitFor();
    assert.equal(await trigger.innerText(), "2");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "Clear filters", exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has("assignment") && !url.searchParams.has("filter") && url.searchParams.get("q") === "Printer");
    await closeFilters(page);
    assert.equal(await trigger.getAttribute("aria-label"), "Filters");
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "Printer");
    await page.goBack();
    await page.getByRole("button", { name: "Filters, 2 applied", exact: true }).waitFor();
    const restored = new URL(page.url()).searchParams;
    assert.equal(restored.get("q"), "Printer");
    assert.equal(restored.get("assignment"), "mine");
    assert.equal(restored.get("filter"), "new");
  } finally { await context.close(); }
});

test("staff restores each Project’s view and returns to the Ticket trigger", async () => {
  const { page, context } = await open("staff");
  const views = page.getByRole("group", { name: "Ticket view" });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
    const statusFilter = page.getByRole("combobox", { name: copy("en", "ticketStatus"), exact: true });
    const expectStatus = async (value: string) => {
      await openFilters(page);
      assert.equal(await statusFilter.inputValue(), value);
      await closeFilters(page);
    };
    await expectStatus("all");
    await views.getByRole("button", { name: "Queue", exact: true }).click();
    await expectStatus("active");
    await views.getByRole("button", { name: "Board", exact: true }).click();
    await expectStatus("all");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="kanban-column"]').length === 5);
    const destinations = page.getByRole("navigation", { name: copy("en", "project"), exact: true });
    await destinations.getByRole("button", { name: "Archive", exact: true }).click();
    await destinations.getByRole("button", { name: "Tickets", exact: true }).click();
    await expectStatus("all");
    await page.waitForFunction(() => document.querySelectorAll('[data-slot="kanban-column"]').length === 5);
    await openFilters(page);
    await statusFilter.selectOption("active");
    await closeFilters(page);
    await views.getByRole("button", { name: "Table", exact: true }).click();
    await expectStatus("active");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "High or critical", exact: true }).click();
    await closeFilters(page);
    await page.getByRole("button", { name: "Filters, 1 applied", exact: true }).waitFor();
    await chooseProject(page, "APP");
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
    await views.getByRole("button", { name: "Board", exact: true }).click();
    await chooseProject(page, "POS");
    await page.getByRole("button", { name: "Filters", exact: true }).waitFor();
    assert.equal(await views.getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    const row = page.locator("button[data-ticket-id]:visible").first();
    const id = await row.getAttribute("data-ticket-id");
    await row.click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: copy("en", "queueFocus"), exact: true }).click();
    assert.equal(new URL(page.url()).searchParams.get("view"), "focus");
    assert.equal(await dialog.evaluate(el => Math.round(el.getBoundingClientRect().width)), await page.evaluate(() => document.documentElement.clientWidth));
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await page.waitForFunction(id => document.activeElement?.getAttribute("data-ticket-id") === id, id);
    assert.equal(await views.getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    await openFilters(page);
    await filterPanel(page).getByRole("button", { name: "High or critical", exact: true }).click();
    await closeFilters(page);
    await page.getByRole("button", { name: "Filters, 1 applied", exact: true }).waitFor();
    await chooseProject(page, "APP");
    assert.equal(await views.getByRole("button", { name: "Board", exact: true }).getAttribute("aria-pressed"), "true");
  } finally { await context.close(); }
});

test("an open Ticket announces leaving filtered results in Queue, Board and Table", async () => {
  const { page, context, token, errors } = await open("staff");
  try {
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await openFilters(page);
    await page.getByRole("combobox", { name: copy("en", "ticketStatus"), exact: true }).selectOption("new");
    await closeFilters(page);
    for (const view of ["Queue", "Board", "Table"]) {
      const title = `Result change ${view} ${crypto.randomUUID()}`;
      const { ticket } = await convex.mutation(api.tickets.createTextTicket, {
        token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID(),
      });
      await page.getByPlaceholder(copy("en", "search"), { exact: true }).fill(title);
      await page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: view }).click();
      await page.locator(`button[data-ticket-id="${ticket._id}"]:visible`).click();
      const detail = view === "Queue" ? page.getByRole("region", { name: title, exact: true }) : page.getByRole("dialog");
      await detail.getByRole("button", { name: new RegExp(`^${copy("en", "queueAcknowledge")} ·`) }).click();
      await detail.getByRole("status").filter({ hasText: copy("en", "detailLeftResults") }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get("ticket"), ticket._id);
      await detail.getByRole("button", { name: copy("en", view === "Queue" ? "detailBack" : "closeDialog"), exact: true }).click();
      await detail.waitFor({ state: "hidden" });
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const [language, view] of [["en", "queue"], ["th", "table"]] as const) test(`staff ${language} ${view}: status menu and move button keep keyboard focus while the move saves`, async () => {
  const intercepted = new EventEmitter();
  let release: (() => void) | undefined;
  let writes = 0;
  const { page, context, token, errors } = await open("staff", language, async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === "Mutation" && message.udfPath === "tickets:updateTicketStatus") {
          writes++;
          release = () => { release = undefined; server.send(raw); };
          intercepted.emit("move");
        } else server.send(raw);
      });
    });
  });
  try {
    const title = `Status focus ${language} ${crypto.randomUUID()}`;
    const { ticket } = await convex.mutation(api.tickets.createTextTicket, { token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID() });
    const number = formatTicketNumber(ticket.ticketNumber, "POS");
    if (view === "table") await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/staff?project=POS&view=${view}&ticket=${ticket._id}`);
    const detail = view === "queue"
      ? page.getByRole("region", { name: title, exact: true })
      : page.getByRole("dialog", { name: number, exact: true });
    const status = detail.locator('[data-slot="dropdown-menu-trigger"]');
    const label = (key: "new" | "inProgress" | "done") => `${copy(language, "detailStatus")} · ${copy(language, key)} · ${number}`;
    const focused = (control: Locator) => control.evaluate(element => element === document.activeElement);
    const saving = detail.getByRole("status").filter({ hasText: copy(language, "statusWriting") });

    assert.equal(await status.getAttribute("aria-label"), label("new"));
    await status.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("menuitemradio", { name: copy(language, "inProgress"), exact: true }).focus();
    await Promise.all([once(intercepted, "move", { signal: AbortSignal.timeout(5000) }), page.keyboard.press("Enter")]);
    await page.getByRole("menu").waitFor({ state: "detached" });
    await saving.waitFor();
    assert.equal(await status.getAttribute("aria-disabled"), "true");
    assert.equal(await focused(status), true, "Focus stays on the status trigger during the save");
    await page.keyboard.press("Enter");
    assert.equal(await page.getByRole("menu").count(), 0, "A busy trigger does not open");
    assert.ok(release);
    release();
    await saving.waitFor({ state: "detached" });
    await detail.getByRole("button", { name: label("inProgress"), exact: true }).waitFor();
    assert.equal(await status.getAttribute("aria-disabled"), null);
    assert.equal(await focused(status), true, "Focus stays on the status trigger after the save");

    const resolve = detail.getByRole("button", { name: `${copy(language, "queueResolve")} · ${number}`, exact: true });
    await resolve.focus();
    await Promise.all([once(intercepted, "move", { signal: AbortSignal.timeout(5000) }), page.keyboard.press("Enter")]);
    await saving.waitFor();
    assert.equal(await resolve.getAttribute("aria-disabled"), "true");
    assert.equal(await focused(resolve), true, "Focus stays on the move button during the save");
    await page.keyboard.press("Enter");
    assert.ok(release);
    release();
    await detail.getByRole("button", { name: label("done"), exact: true }).waitFor();
    await saving.waitFor({ state: "detached" });
    assert.equal(await focused(detail.getByRole("button", { name: `${copy(language, "queueReopen")} · ${number}`, exact: true })), true, "Focus stays on the move button after the save");
    assert.equal(writes, 2, "Busy controls never send a second move");
    assert.equal((await convex.query(api.tickets.getWorkspaceTicket, { token, projectId: ticket.projectId, ticket: ticket._id }))?.status, "done");
    assert.deepEqual(errors, []);
  } finally { release?.(); await context.close(); }
});

test("a status check finishing in another Project is shown once on return", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const { page, context, token } = await open("staff", "en", async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.type === "Mutation" && message.udfPath === "tickets:updateTicketStatus") {
          // Force the real local backend's version check, then hold the reconciliation read.
          writes++;
          message.args[0].expectedVersion += 1;
          server.send(JSON.stringify(message));
        } else server.send(raw);
      });
    });
    await context.route("**/api/query", async route => {
      if (route.request().postDataJSON()?.path === "tickets:getWorkspaceTicket") await held;
      await route.continue();
    });
  });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const title = `Deferred status ${crypto.randomUUID()}`;
    const { ticket } = await convex.mutation(api.tickets.createTextTicket, { token, projectKey: "POS", title, description: "", requestId: crypto.randomUUID() });
    const number = formatTicketNumber(ticket.ticketNumber, "POS");
    await page.getByPlaceholder(copy("en", "search"), { exact: true }).fill(title);
    await Promise.all([
      page.waitForRequest(req => req.url().endsWith("/api/query") && req.postDataJSON()?.path === "tickets:getWorkspaceTicket"),
      page.getByRole("button", { name: `Acknowledge · ${number}`, exact: true }).click(),
    ]);
    await chooseProject(page, "APP");
    const finished = page.waitForEvent("requestfinished", req => req.url().endsWith("/api/query"));
    release();
    await finished;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const notice = page.getByText(`${number} · Latest saved version · New`, { exact: true });
    assert.equal(await notice.count(), 0);
    await chooseProject(page, "POS");
    await notice.waitFor();
    await chooseProject(page, "APP");
    await notice.waitFor({ state: "hidden" });
    await chooseProject(page, "POS");
    assert.equal(await notice.count(), 0);
    assert.equal(writes, 1);
  } finally { release(); await context.close(); }
});

test("staff explorer keeps table and filters across indexed search, tag assignment and archive restore", async () => {
  const f = await open("staff");
  const name = `Explorer ${crypto.randomUUID()}`;
  const created = await convex.mutation(api.tickets.createTextTicket, {
    token: f.token, projectKey: "POS", title: name, description: "Integration fixture", requestId: crypto.randomUUID(),
  });
  const id = created.ticket._id;
  const tagName = `Tag ${crypto.randomUUID().slice(0, 8)}`;
  try {
    await f.page.getByRole("button", { name: "Close dialog", exact: true }).click();
    const search = f.page.getByPlaceholder(copy("en", "search"), { exact: true });
    await search.fill(name);
    await f.page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: "Table", exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const dialog = f.page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: copy("en", "detailActions"), exact: true }).click();
    await dialog.getByRole("button", { name: copy("en", "ticketTags"), exact: true }).click();
    await dialog.getByLabel(copy("en", "tagName"), { exact: true }).fill(tagName);
    await dialog.getByRole("button", { name: copy("en", "createTag"), exact: true }).click();
    const tag = dialog.getByRole("button", { name: `+ ${tagName}`, exact: true });
    await tag.click();
    await dialog.getByRole("button", { name: `✓ ${tagName}`, exact: true }).waitFor();
    const assigned = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.deepEqual(assigned?.tags.map(t => t.name), [tagName]);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
    await openFilters(f.page);
    await f.page.getByRole("button", { name: "Add filter", exact: true }).click();
    await f.page.getByRole("option", { name: "Tags", exact: true }).click();
    await f.page.getByRole("option", { name: "is any of", exact: true }).click();
    await f.page.getByRole("option", { name: tagName, exact: true }).click();
    await f.page.keyboard.press("Escape");
    await closeFilters(f.page);
    await search.fill("unmatchedfixturetext");
    await f.page.waitForURL(url => url.searchParams.get("q") === "unmatchedfixturetext");
    await f.page.getByText("No Tickets match these filters.", { exact: true }).waitFor();
    const clear = f.page.getByRole("button", { name: copy("en", "clearSearch"), exact: true });
    await clear.click();
    await f.page.waitForURL(url => !url.searchParams.has("q"));
    assert.equal(await search.inputValue(), "");
    assert.equal(await search.evaluate(input => input === document.activeElement), true);
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).waitFor();
    assert.equal(await f.page.getByRole("group", { name: "Ticket view" }).getByRole("button", { name: "Table", exact: true }).getAttribute("aria-pressed"), "true");
    await search.fill(name);
    const row = f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) });
    await row.click();
    await dialog.getByRole("button", { name: copy("en", "detailActions"), exact: true }).click();
    // Staff archive goes through the real confirmation. Cancel and Escape both
    // dismiss it without a write; focus returns to the Archive trigger.
    const archiveTrigger = dialog.getByRole("button", { name: copy("en", "archive"), exact: true });
    const confirm = f.page.getByRole("alertdialog", { name: copy("en", "archive"), exact: true });
    await archiveTrigger.click();
    await confirm.getByText(copy("en", "archiveConfirm"), { exact: true }).waitFor();
    await confirm.getByRole("button", { name: copy("en", "cancel"), exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await archiveTrigger.focus();
    await f.page.keyboard.press("Enter");
    await confirm.waitFor();
    await f.page.keyboard.press("Escape");
    await confirm.waitFor({ state: "hidden" });
    await f.page.waitForFunction(trigger => trigger === document.activeElement, await archiveTrigger.elementHandle());
    const dismissed = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(dismissed?.lifecycle, "active");
    assert.equal(dismissed?.version, assigned?.version, "Dismissing the confirmation must not write");
    await archiveTrigger.click();
    await confirm.getByRole("button", { name: copy("en", "archive"), exact: true }).click();
    await confirm.waitFor({ state: "hidden" });
    await dialog.waitFor({ state: "hidden" });
    await row.waitFor({ state: "hidden" });
    const archivedTicket = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(archivedTicket?.lifecycle, "archived");
    assert.ok(archivedTicket?.archivedAt);
    assert.deepEqual(archivedTicket?.tagIds, assigned?.tagIds);
    await f.page.getByRole("button", { name: copy("en", "archive"), exact: true }).click();
    await f.page.getByRole("button", { name: new RegExp(`Open Ticket .*${name}`) }).click();
    const archived = f.page.getByRole("dialog").last();
    assert.equal(await archived.getByRole("button", { name: copy("en", "edit"), exact: true }).count(), 0);
    await archived.getByRole("button", { name: "Restore", exact: true }).click();
    await archived.waitFor({ state: "hidden" });
    const restored = await convex.query(api.tickets.getTicket, { token: f.token, id });
    assert.equal(restored?.lifecycle, "active");
    assert.deepEqual(restored?.tagIds, assigned?.tagIds);
    assert.deepEqual(f.errors, []);
    assert.equal(f.uploads(), 0);
  } finally { await f.context.close(); }
});

for (const language of ["en", "th"] as const) test(`keyboard pin placement and adjustment (${language})`, async () => {
  const { page, context, uploads } = await open("customer", language);
  try {
    const video = language === "th";
    if (video) await page.locator('[data-slot="ticket-draft-files"]').setInputFiles("tests/browser/pin-video.webm");
    else {
      await files(page);
      await files(page, "second.png");
      const handle = page.getByRole("button", { name: copy(language, "reorderFile", { name: "draft.png" }), exact: true });
      await handle.press("Enter");
      const positions = page.getByRole("group", { name: copy(language, "filePosition", { name: "draft.png" }), exact: true });
      await positions.getByRole("button", { name: "2", exact: true }).press("Enter");
      await page.waitForFunction(() => document.querySelector('[data-slot="sortable-item"] img')?.getAttribute("alt") === "second.png");
    }
    await page.getByRole("button", { name: copy(language, "openMedia", { name: video ? "pin-video.webm" : "draft.png" }), exact: true }).press("Enter");
    const dialog = page.getByRole("dialog").last();
    await dialog.getByRole("button", { name: copy(language, "addPin"), exact: true }).press("Enter");
    const surface = dialog.getByRole("button", { name: copy(language, "markPoint"), exact: true });
    if (video) {
      const scrubber = dialog.getByRole("slider");
      await scrubber.press("End");
      await surface.focus();
    }
    await surface.press("Shift+ArrowRight");
    await surface.press("ArrowUp");
    await dialog.getByText(copy(language, "pinPosition", { x: 60, y: 49 }), { exact: true }).waitFor();
    await surface.press("Enter");
    await dialog.getByPlaceholder(copy(language, "describeIssue")).fill("Keyboard placement");
    await dialog.getByRole("button", { name: copy(language, "savePin"), exact: true }).press("Enter");
    const marker = dialog.getByRole("button", { name: `${copy(language, "comment", { label: 1 })}: Keyboard placement`, exact: true });
    await marker.press("Enter");
    await dialog.getByRole("button", { name: copy(language, "repositionPin"), exact: true }).press("Enter");
    await surface.press("ArrowLeft");
    await surface.press("Space");
    await page.waitForFunction(() => document.querySelector<HTMLElement>("[data-pin-id]")?.style.left === "59%");
    assert.equal(uploads(), 0);
  } finally { await context.close(); }
});

for (const role of ["staff", "customer"] as const) for (const language of ["en", "th"] as const) {
  test(`${role} ${language}: phone surfaces fit 320 and 390 pixels and three Tickets take three activations`, async () => {
    const { page, context, errors } = await open(role, language);
    const queueHeading = page.getByRole("heading", { level: 1, name: copy(language, role === "staff" ? "queueTitle" : "yourTickets"), exact: true });

    async function checkWidths(surface: ReturnType<Page["locator"]>) {
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 740 });
        await surface.waitFor({ state: "visible" });
        const dimensions = await surface.evaluate(element => ({
          page: document.documentElement.scrollWidth,
          viewport: document.documentElement.clientWidth,
          surface: element.scrollWidth,
          inner: element.clientWidth,
        }));
        assert.ok(dimensions.page <= dimensions.viewport + 1, `Page overflow at ${width}px: ${JSON.stringify(dimensions)}`);
        assert.ok(dimensions.surface <= dimensions.inner + 1, `Surface overflow at ${width}px: ${JSON.stringify(dimensions)}`);
      }
    }

    try {
      await checkWidths(page.getByRole("dialog"));
      assert.equal(await queueHeading.count(), 0, "Modal keeps the queue outside the accessibility tree");
      await page.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      if (role === "staff") await page.getByRole("button", { name: copy(language, "queueLabel"), exact: true }).click();
      await queueHeading.waitFor();
      await checkWidths(page.getByRole("main"));

      await openHeaderMenu(page, copy(language, role === "staff" ? "queueMore" : "customerQueueMore"));
      const signOut = page.getByRole("menuitem", { name: copy(language, "signOut"), exact: true });
      await signOut.waitFor();
      // A trusted press outside the menu dismisses it (Base UI ignores synthetic events).
      // Menus keep an 8 px viewport inset, so x = 4 is always outside the popup.
      const heading = (await queueHeading.boundingBox())!;
      await page.mouse.click(4, heading.y + heading.height / 2);
      await signOut.waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("menu").count(), 0);

      if (role === "staff") {
        const acknowledge = page.getByRole("button", { name: new RegExp(`^${copy(language, "queueAcknowledge")} ·`) }).first();
        await acknowledge.waitFor();
        const id = await acknowledge.locator("xpath=ancestor::article").locator("[data-ticket-id]").getAttribute("data-ticket-id");
        await acknowledge.click();
        const sameRow = page.locator("article").filter({ has: page.locator(`button[data-ticket-id="${id}"]`) });
        await sameRow.getByRole("button", { name: new RegExp(`^${copy(language, "queueStart")} ·`) }).waitFor();
        assert.equal(new URL(page.url()).searchParams.has("ticket"), false, "A single queue action advanced the Ticket in place");
      }

      const rows = page.locator("button[data-ticket-id]:visible");
      await rows.nth(2).waitFor();
      const ids = await rows.evaluateAll(buttons => buttons.slice(0, 3).map(button => button.getAttribute("data-ticket-id")));
      assert.equal(new Set(ids).size, 3);
      await rows.first().click();
      for (let index = 0; index < ids.length; index++) {
        if (index) await page.getByRole("button", { name: copy(language, "detailNext"), exact: true }).click();
        await page.waitForURL(url => url.searchParams.get("ticket") === ids[index]);
        const detail = page.locator("section[tabindex='-1'][aria-labelledby]");
        await detail.getByRole("heading", { level: 2 }).waitFor();
        await checkWidths(detail);
        assert.equal(await rows.count(), 0, "Only the selected Ticket is visible");
        assert.equal(await queueHeading.count(), 0);
      }
      await page.getByRole("button", { name: copy(language, "detailBack"), exact: true }).click();
      await queueHeading.waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}

test("a customer joins from an invitation link, saves a recovery code, then recovers the account with it", async () => {
  const projectId = seed.projects.find(project => project.key === "POS")!.id;
  const invitation = await convex.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: seed.sessions[0], projectId });
  redact(invitation.secret);
  const username = `joiner${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const context = await newContext(await browsers.get());
  let code = "";
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await context.newPage();
    await page.goto(`${baseURL}/customer/join#invite=${encodeURIComponent(invitation.secret)}`);
    await page.getByText(copy("en", "joinTitle", { project: "Point of Sale" }), { exact: true }).waitFor();
    const notice = page.getByRole("link", { name: copy("en", "pilotPrivacyNotice"), exact: true });
    assert.equal(await notice.getAttribute("href"), "https://privacy.example.test/en");
    assert.equal(await notice.getAttribute("referrerpolicy"), "no-referrer");
    await page.locator("#join-username").fill(` ${username.toUpperCase()} `);
    await page.getByText(copy("en", "usernamePreview", { username }), { exact: true }).waitFor();
    await page.locator("#join-display-name").fill("สมหญิง ใจดี");
    await page.locator("#new-password").fill("browser join passphrase");
    await page.locator("#new-password-confirm").fill("browser join passphrase");
    await page.getByRole("button", { name: copy("en", "createAccount"), exact: true }).click();
    const enrollment = page.getByRole("heading", { name: copy("en", "recoveryEnrollmentTitle"), exact: true });
    await enrollment.waitFor();
    assert.equal(await enrollment.evaluate(element => element === document.activeElement), true);
    await page.getByText(copy("en", "recoveryCodeNeeded"), { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "recoveryCodeCreate"), exact: true }).press("Enter");
    code = (await page.locator("output").innerText()).trim();
    redact(code);
    assert.match(code, /^[0-9A-Z]{5}(-[0-9A-Z]{1,5}){5}$/);
    assert.equal(await page.getByRole("button", { name: "New Ticket", exact: true }).count(), 0);
    await page.getByRole("button", { name: copy("en", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    await openHeaderMenu(page, copy("en", "customerQueueMore"));
    await page.getByRole("menuitem", { name: copy("en", "accountTitle"), exact: true }).click();
    const account = page.getByRole("dialog", { name: copy("en", "accountTitle"), exact: true });
    assert.equal(await account.getByRole("link", { name: copy("en", "pilotPrivacyNotice") }).getAttribute("href"), "https://privacy.example.test/en");
    // The invitation is single use.
    assert.deepEqual(await convex.query(api.identity.previewCustomerInvitation, { invitation: invitation.secret }), { status: "INVITE_USED" });
  } finally { await context.close(); }
  const fresh = await newContext(await browsers.get());
  try {
    await fresh.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    const page = await fresh.newPage();
    await page.goto(`${baseURL}/customer/recover`);
    await page.locator("#recover-username").fill(username);
    await page.locator("#recover-code").fill("0".repeat(26));
    await page.locator("#new-password").fill("recovered browser passphrase");
    await page.locator("#new-password-confirm").fill("recovered browser passphrase");
    await page.getByRole("button", { name: copy("en", "recoverAction"), exact: true }).click();
    await page.getByRole("alert").getByText(copy("en", "recoverFailed"), { exact: true }).waitFor();
    await page.locator("#recover-code").fill(code.toLowerCase());
    await page.getByRole("button", { name: copy("en", "recoverAction"), exact: true }).click();
    await page.getByText(copy("en", "recoverSuccess"), { exact: true }).waitFor();
    await page.goto(`${baseURL}/customer/login`);
    await page.locator("#customer-username").fill(username);
    await page.locator("#customer-password").fill("recovered browser passphrase");
    await page.getByRole("button", { name: copy("en", "signIn"), exact: true }).click();
    await page.getByText(copy("en", "recoveryCodeNeeded"), { exact: true }).waitFor();
    await page.getByRole("button", { name: copy("en", "recoveryCodeCreate"), exact: true }).press("Enter");
    redact((await page.locator("output").innerText()).trim());
    await page.getByRole("button", { name: copy("en", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
  } finally { await fresh.close(); }
});

test("Thai keyboard customer recovery returns to sign-in and resumes Join with the invitation held only in memory", async () => {
  const owner = seed.sessions[0];
  const [pos, app] = ["POS", "APP"].map(key => seed.projects.find(project => project.key === key)!.id);
  const createInvitation = (projectId: Id<"projects">) =>
    convex.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, token: owner, projectId });
  const username = `returning${crypto.randomUUID().slice(0, 8)}`;
  const password = "browser returning passphrase";
  const newPassword = "รหัสผ่านใหม่สำหรับลูกค้าประจำ";
  const first = await createInvitation(pos);
  redact(first.secret);
  const signup = await convex.mutation(api.auth.signUpWithInvitation, { invitation: first.secret, username, displayName: "ลูกค้าประจำ", password });
  assert.equal(signup.status, "complete");
  if (signup.status !== "complete") throw new Error("Customer fixture enrollment failed");
  const token = signup.tokens.accessToken;
  redact(token);
  const saved = await convex.mutation(api.identity.createRecoveryCode, { token });
  if (!saved.ok) throw new Error("Customer fixture recovery setup failed");
  redact(saved.code);
  assert.deepEqual(await convex.mutation(api.identity.confirmRecoveryEnrollment, { token, code: saved.code }), { ok: true });
  const invitation = await createInvitation(app);
  redact(invitation.secret);

  const context = await newContext(await browsers.get(), { locale: "th-TH", viewport: { width: 390, height: 844 } });
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "th"));
    const page = await context.newPage();
    const requestLocations: string[] = [];
    const documentRequests: string[] = [];
    page.on("request", request => {
      requestLocations.push(request.url(), request.headers().referer ?? "");
      if (request.resourceType() === "document") documentRequests.push(request.url());
    });
    const checkInMemoryOnly = async () => {
      assert.equal(requestLocations.some(value => value.includes(invitation.secret)), false);
      assert.equal(await page.evaluate(secret => [history.state, location.href, ...Object.values(localStorage), ...Object.values(sessionStorage)]
        .some(value => JSON.stringify(value)?.includes(secret)), invitation.secret), false);
    };
    await page.goto(`${baseURL}/customer/join#invite=${invitation.secret}`);
    await page.getByRole("heading", { name: copy("th", "joinTitle", { project: "Customer App" }) }).waitFor();
    const joinPath = `${baseURL}/customer/join`;
    await page.waitForURL(joinPath);
    const useExisting = page.getByRole("button", { name: copy("th", "haveAccountQuestion"), exact: true });
    await useExisting.press("Enter");
    await page.waitForURL(`${baseURL}/customer/login`);
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).press("Enter");
    await page.waitForURL(joinPath);
    await useExisting.press("Enter");
    const userField = page.getByRole("textbox", { name: copy("th", "username"), exact: true });
    await userField.waitFor();
    assert.equal(await userField.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(username);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText("ใส่รหัสผ่านผิด");
    await page.keyboard.press("Enter");
    const error = page.getByRole("alert").filter({ hasText: copy("th", "invalidCredentials") });
    await error.waitFor();
    assert.equal(await error.evaluate(element => element === document.activeElement), true);
    const forgot = page.getByRole("link", { name: copy("th", "forgotPassword"), exact: true });
    await forgot.press("Enter");
    await page.waitForURL(`${baseURL}/customer/recover`);
    await checkInMemoryOnly();
    await page.getByRole("link", { name: copy("th", "customerSignIn"), exact: true }).press("Enter");
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).waitFor();
    await forgot.press("Enter");
    const recoverUsername = page.locator("#recover-username");
    await recoverUsername.waitFor();
    assert.equal(await recoverUsername.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(` ${username.toUpperCase()} `);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(saved.code.toLowerCase());
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Tab"); // Show password
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Enter");
    const recovered = page.getByRole("status").filter({ hasText: copy("th", "recoverSuccess") });
    await recovered.waitFor();
    assert.equal(await recovered.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await page.waitForURL(`${baseURL}/customer/login`);
    await page.getByRole("button", { name: copy("th", "backToInvitation"), exact: true }).waitFor();
    await checkInMemoryOnly();
    assert.equal(await userField.evaluate(element => element === document.activeElement), true);
    await page.keyboard.insertText(username);
    await page.keyboard.press("Tab");
    await page.keyboard.insertText(newPassword);
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: copy("th", "recoveryCodeCreate"), exact: true }).press("Enter");
    redact((await page.locator("output").innerText()).trim());
    await page.getByRole("button", { name: copy("th", "recoveryCodeSaved"), exact: true }).press("Enter");
    await page.waitForURL(joinPath);
    await page.getByText(copy("th", "joinAsCustomer", { project: "Customer App", username }), { exact: true }).waitFor();
    const join = page.getByRole("button", { name: copy("th", "joinAction"), exact: true });
    assert.equal(await join.evaluate(element => element === document.activeElement), true);
    await page.keyboard.press("Enter");
    // Joining opens the joined Project.
    await page.waitForURL(`${baseURL}/customer?project=APP`);
    assert.deepEqual(await convex.query(api.identity.previewCustomerInvitation, { invitation: invitation.secret }), { status: "INVITE_USED" });
    await checkInMemoryOnly();
    assert.deepEqual(documentRequests, [joinPath]);
  } finally { await context.close(); }
});

test("Owner verifies staff invitation creation and reissue, then replaces and revokes an exact Google account", async () => {
  const admin = localIdentityAdmin();
  const fixture = await admin(internal.seed.installBrowserStaffAccounts, {});
  const owner = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.ownerEmail });
  const former = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.memberEmail });
  if (owner.status !== "complete" || former.status !== "complete") throw new Error("Staff fixtures failed to sign in");
  for (const tokens of [owner.tokens, former.tokens, fixture.candidate]) {
    redact(tokens.accessToken);
    redact(tokens.refreshToken);
  }
  const browser = await browsers.get();
  const keys = authStorageKeys();
  async function openSession(tokens: { accessToken: string; refreshToken: string }, path: string) {
    const context = await newContext(browser);
    await context.addInitScript(({ keys: { jwt, refresh }, accessToken, refreshToken }) => {
      sessionStorage.setItem(jwt, accessToken);
      sessionStorage.setItem(refresh, refreshToken);
      localStorage.setItem("ease-pos-tracking-language", "en");
    }, { keys, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
    const page = await context.newPage();
    await page.goto(baseURL + path);
    return { context, page };
  }
  const candidate = await openSession(fixture.candidate, "/staff/login");
  const authority = await openSession(owner.tokens, "/staff");
  try {
    await candidate.page.getByRole("heading", { name: copy("en", "pendingTitle"), exact: true }).waitFor();
    await candidate.page.getByText(fixture.candidate.subject, { exact: true }).waitFor();
    await candidate.page.getByText(fixture.candidate.email, { exact: true }).waitFor();
    assert.equal(candidate.page.url().includes(fixture.candidate.subject), false);
    const { page } = authority;
    await openHeaderMenu(page, copy("en", "queueMore"), "Enter");
    await page.getByRole("menuitem", { name: copy("en", "teamTitle"), exact: true }).press("Enter");
    const team = page.getByRole("dialog", { name: copy("en", "teamTitle"), exact: true });
    const codeField = team.getByRole("textbox", { name: copy("en", "verificationCode"), exact: true });
    async function confirm(purpose: string, testError = false) {
      await codeField.and(page.locator(":focus")).waitFor();
      const delivery = await admin(internal.identity.readLocalDelivery, { to: fixture.ownerEmail });
      if (!delivery) throw new Error("Local verification delivery missing");
      assert.equal(delivery.purpose, purpose);
      redact(delivery.code);
      if (testError) {
        await codeField.fill(delivery.code === "00000000" ? "11111111" : "00000000");
        await codeField.press("Enter");
        const error = team.getByRole("alert").filter({ hasText: copy("en", "invalidCode") });
        await error.waitFor();
        assert.equal(await error.evaluate(element => element === document.activeElement), true);
      }
      await codeField.fill(delivery.code);
      await codeField.press("Enter");
      await codeField.waitFor({ state: "hidden" });
      assert.equal(page.url().includes(delivery.code), false);
    }

    const inviteEmail = `invite-${crypto.randomUUID()}@local.test`;
    await team.getByRole("textbox", { name: copy("en", "inviteEmail"), exact: true }).fill(inviteEmail);
    await team.locator("#invite-staff-role").selectOption("owner");
    await team.getByRole("button", { name: copy("en", "inviteStaff"), exact: true }).press("Enter");
    await team.getByRole("heading", { name: copy("en", "teamActionReview", { action: copy("en", "inviteStaff"), email: inviteEmail, role: "Owner" }) }).waitFor();
    await confirm("staff-invite-create", true);
    const link = team.locator("output");
    const originalLink = await link.innerText();
    redact(originalLink);
    await team.getByRole("listitem").filter({ hasText: inviteEmail }).getByRole("button", { name: copy("en", "reissue"), exact: true }).press("Enter");
    await confirm("staff-invite-reissue");
    const reissuedLink = await link.innerText();
    redact(reissuedLink);
    assert.ok(reissuedLink !== originalLink);

    const googleButton = (email: string) => team.getByRole("button", { name: copy("en", "staffGoogleAccountFor", { email }), exact: true });
    await googleButton(fixture.memberEmail).press("Enter");
    await team.getByRole("textbox", { name: copy("en", "googleVerifiedEmail"), exact: true }).fill(fixture.candidate.email);
    await team.getByRole("textbox", { name: copy("en", "googleSubject"), exact: true }).fill(fixture.candidate.subject);
    await team.getByRole("textbox", { name: copy("en", "googleEvidenceRef"), exact: true }).fill("fixture/staff-replacement");
    await team.getByRole("button", { name: copy("en", "sendCode"), exact: true }).press("Enter");
    await team.getByText(fixture.candidate.subject, { exact: true }).waitFor();
    await team.getByText(fixture.candidate.email, { exact: true }).waitFor();
    await confirm("staff-google-binding");
    assert.equal(await convex.query(api.identity.viewer, { token: former.tokens.accessToken }), null);
    assert.equal(await convex.query(api.identity.viewer, { token: fixture.candidate.accessToken }), null);
    const replacement = await convex.mutation(api.auth.signInLocalFixture, { email: fixture.candidate.email });
    if (replacement.status !== "complete") throw new Error("Staff replacement did not admit a fresh session");
    redact(replacement.tokens.accessToken);
    redact(replacement.tokens.refreshToken);
    assert.partialDeepStrictEqual(await convex.query(api.identity.viewer, { token: replacement.tokens.accessToken }), {
      staffId: fixture.memberId, email: fixture.candidate.email, role: "staff",
    });

    await googleButton(fixture.candidate.email).press("Enter");
    await team.getByRole("combobox", { name: copy("en", "googleBindingAction"), exact: true }).selectOption("revoke");
    await team.getByText(copy("en", "googleRevokeEffect"), { exact: true }).waitFor();
    await team.getByRole("textbox", { name: copy("en", "googleEvidenceRef"), exact: true }).fill("fixture/staff-revocation");
    await team.getByRole("button", { name: copy("en", "sendCode"), exact: true }).press("Enter");
    await confirm("staff-google-binding");
    await googleButton(fixture.candidate.email).filter({ hasText: copy("en", "googleBindingRevoked") }).waitFor();
    assert.equal(await convex.query(api.identity.viewer, { token: replacement.tokens.accessToken }), null);
  } finally {
    await authority.context.close();
    await candidate.context.close();
  }
});

test("staff deep link survives a query-free Google redirect through tab return storage", async () => {
  const context = await newContext(await browsers.get());
  try {
    await context.addInitScript(() => localStorage.setItem("ease-pos-tracking-language", "en"));
    let observe!: (url: string) => void;
    const started = new Promise<string>(resolve => { observe = resolve; });
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const message = JSON.parse(String(raw));
        if (message.udfPath === "auth:startSignInWithClerk") {
          observe(message.args[0].redirectTo);
          return;
        }
        server.send(raw);
      });
      server.onMessage(raw => socket.send(raw));
    });
    const page = await context.newPage();
    const search = new URLSearchParams({ project: "POS", q: "007", ticket: seed.tickets[0] });
    await page.goto(`${baseURL}/staff?${search}`);
    await page.waitForURL(url => url.pathname === "/staff/login" && !!url.searchParams.get("redirect"));
    const google = page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true });
    const [returnURL] = await Promise.all([started, google.click()]);
    assert.equal(returnURL, new URL("/staff/login", baseURL).href);
    // Returning from Google lands on bare /staff/login; completing sign-in consumes the stashed return target once.
    await page.goto(returnURL);
    await page.getByRole("button", { name: "owner@local.test", exact: true }).click();
    await page.getByRole("dialog").getByRole("heading", { name: "Printer needs review", exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get("project"), "POS");
    assert.equal(new URL(page.url()).searchParams.get("ticket"), seed.tickets[0]);
    assert.equal(await page.getByPlaceholder("Search", { exact: true }).inputValue(), "007");
    await page.goto(`${baseURL}/staff/login`);
    await page.waitForURL(url => url.pathname === "/staff" && !!url.searchParams.get("project"));
    assert.equal(new URL(page.url()).searchParams.has("ticket"), false);
  } finally { await context.close(); }
});

test("authorized, malformed, wrong-Project and cross-customer Ticket deep links enforce the same unavailable state", async () => {
  const staff = await open("staff");
  const customer = await open("customer");
  try {
    // Staff: authorized Queue deep link opens the Ticket and closes cleanly.
    await staff.page.goto(`${baseURL}/staff?project=POS&view=queue&ticket=${seed.tickets[0]}`);
    const staffAuthorized = staff.page.getByRole("region", { name: "Printer needs review", exact: true });
    await staffAuthorized.waitFor();
    await staffAuthorized.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await staff.page.waitForURL(url => !url.searchParams.has("ticket"));

    // Staff: malformed and wrong-Project links show the same unavailable state in inline Queue view.
    for (const path of ["/staff?project=POS&view=queue&ticket=bad", `/staff?project=APP&view=queue&ticket=${seed.tickets[0]}`]) {
      await staff.page.goto(baseURL + path);
      const panel = staff.page.getByRole("region", { name: copy("en", "ticket"), exact: true });
      await panel.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await panel.getByText("Printer needs review", { exact: false }).count(), 0);
      await panel.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
      await staff.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    // Staff: malformed and wrong-Project links show the same unavailable state in dialog Table view.
    for (const path of ["/staff?project=POS&view=table&ticket=bad", `/staff?project=APP&view=table&ticket=${seed.tickets[0]}`]) {
      await staff.page.goto(baseURL + path);
      const dialog = staff.page.getByRole("dialog", { name: copy("en", "ticket"), exact: true });
      await dialog.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await dialog.getByText("Printer needs review", { exact: false }).count(), 0);
      await dialog.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
      await staff.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    // Disallowed Ticket characters are rejected by search validation without crashing or opening detail.
    await staff.page.goto(`${baseURL}/staff?project=POS&ticket=${encodeURIComponent("bad/id")}`);
    await staff.page.getByRole("button", { name: "New Ticket", exact: true }).first().waitFor();
    assert.equal(await staff.page.getByRole("region", { name: copy("en", "ticket"), exact: true }).count(), 0);

    // Customer (Alice): own Ticket opens; malformed, wrong-Project and Bob's Ticket are indistinguishable.
    await customer.page.goto(`${baseURL}/customer?project=POS&ticket=${seed.tickets[1]}`);
    const customerAuthorized = customer.page.getByRole("region", { name: "Ticket from Alice", exact: true });
    await customerAuthorized.waitFor();
    await customerAuthorized.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
    await customer.page.waitForURL(url => !url.searchParams.has("ticket"));

    for (const path of [
      "/customer?project=POS&ticket=bad",
      `/customer?project=APP&ticket=${seed.tickets[1]}`,
      `/customer?project=POS&ticket=${seed.tickets[2]}`,
    ]) {
      await customer.page.goto(baseURL + path);
      const panel = customer.page.getByRole("region", { name: copy("en", "ticket"), exact: true });
      await panel.getByRole("alert").filter({ hasText: copy("en", "ticketMissing") }).waitFor();
      assert.equal(await panel.getByText("Ticket from Alice", { exact: false }).count(), 0);
      assert.equal(await panel.getByText("Ticket from Bob", { exact: false }).count(), 0);
      await panel.getByRole("button", { name: copy("en", "detailBack"), exact: true }).click();
      await customer.page.waitForURL(url => !url.searchParams.has("ticket"));
    }

    assert.deepEqual(staff.errors, []);
    assert.deepEqual(customer.errors, []);
  } finally {
    await customer.context.close();
    await staff.context.close();
  }
});

test("active text draft confirms before sign-out without upload traffic", async () => {
  const { page, context, title, token, errors, uploads } = await open("customer", "en");
  try {
    await title.fill("Active text draft");
    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });

    const menu = page.locator("header").getByRole("button", { name: copy("en", "customerQueueMore"), exact: true });
    const signOut = page.getByRole("menuitem", { name: copy("en", "signOut"), exact: true });
    await menu.click();
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.dismiss();
      }),
      signOut.click(),
    ]);
    assert.equal(new URL(page.url()).pathname, "/customer");
    assert.notEqual(await convex.query(api.identity.viewer, { token }), null);
    await page.getByRole("button", { name: copy("en", "resumeTicket"), exact: true }).first().click();
    assert.equal(await title.inputValue(), "Active text draft");

    await page.getByRole("button", { name: copy("en", "closeDialog"), exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await menu.click();
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.accept();
      }),
      signOut.click(),
    ]);
    await page.waitForURL(url => url.pathname === "/customer/login");
    await page.locator("#customer-password").waitFor({ state: "visible" });
    assert.equal(await convex.query(api.identity.viewer, { token }), null);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test("sign-out waits for the active draft to cancel with a live session", { timeout: 30_000 }, async () => {
  let intentRequest: number | undefined;
  let releaseIntent: (() => void) | undefined;
  let received!: (release: () => void) => void;
  const intentResponse = new Promise<() => void>(resolve => { received = resolve; });
  const events: string[] = [];
  const { page, context, title, token, errors, uploads } = await open("staff", "en", async context => {
    await context.routeWebSocket(url => url.hostname === "127.0.0.1" && url.pathname.endsWith("/sync"), socket => {
      const server = socket.connectToServer();
      socket.onMessage(raw => {
        const msg = JSON.parse(String(raw));
        if (msg.udfPath === "uploads:createUploadIntent") intentRequest = msg.requestId;
        if (msg.udfPath === "auth:signOut") events.push("logout");
        server.send(raw);
      });
      let queued: (string | Buffer)[] | undefined;
      server.onMessage(raw => {
        if (queued) { queued.push(raw); return; }
        const msg = JSON.parse(String(raw));
        if (msg.type === "MutationResponse" && intentRequest !== undefined && msg.requestId === intentRequest) {
          // Convex resolves this write when the following Transition arrives.
          // Preserve server message order while holding its acknowledgement.
          queued = [raw];
          received(() => {
            for (const message of queued ?? []) socket.send(message);
            queued = undefined;
          });
        } else socket.send(raw);
      });
    });
    // Convex Auth revokes sessions over its separate HTTP client (/api/mutation).
    await context.route("**/api/mutation", async route => {
      if (route.request().postDataJSON()?.path === "auth:signOut") events.push("logout");
      await route.continue();
    });
    await context.route("**/api/uploads/cancel", async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).ok, true);
      events.push("canceled");
      await route.fulfill({ response });
    });
  });
  try {
    await page.getByRole("button", { name: "Close dialog", exact: true }).click();
    await chooseProject(page, "APP");
    await page.waitForURL(url => url.searchParams.get("project") === "APP");
    await page.getByRole("button", { name: "New Ticket", exact: true }).first().click();
    await title.fill("Sign-out during upload intent creation");
    await files(page);
    await page.getByRole("button", { name: copy("en", "submitTicket"), exact: true }).click();
    await page.getByRole("button", { name: copy("en", "cancelUpload") }).waitFor();
    releaseIntent = await intentResponse;
    // Back would leave the upload's Project. Declining keeps the draft active.
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "switchDuringUpload"));
        await dialog.dismiss();
      }),
      page.evaluate(() => history.back()),
    ]);
    await page.waitForURL(url => url.searchParams.get("project") === "APP");
    assert.equal(await title.inputValue(), "Sign-out during upload intent creation");
    assert.deepEqual(events, []);
    // The modal traps pointer input. Dispatch the workspace action directly to
    // exercise a sign-out arriving while the upload intent response is in flight.
    // The staff overflow menu stays mounted while closed, so the item is wired.
    const signOut = page.locator('[role="menu"] [role="menuitem"]', { hasText: copy("en", "signOut") });
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.dismiss();
      }),
      signOut.dispatchEvent("click"),
    ]);
    assert.deepEqual(events, []);
    const abortsBefore = (await stats(page)).aborts;
    await Promise.all([
      page.waitForEvent("dialog").then(async dialog => {
        assert.equal(dialog.message(), copy("en", "leaveTicketDraft"));
        await dialog.accept();
      }),
      signOut.dispatchEvent("click"),
    ]);
    await page.waitForFunction(before => window.draftStats.aborts > before, abortsBefore);
    assert.deepEqual(events, []);
    releaseIntent();
    releaseIntent = undefined;
    await page.waitForURL(url => url.pathname === "/staff/login");
    await page.getByRole("button", { name: copy("en", "continueWithGoogle"), exact: true }).waitFor({ state: "visible" });
    assert.equal(events[0], "canceled", "Upload cancel must complete with a live session before sign-out");
    assert.equal(events[1], "logout", "Sign-out must follow upload cancellation");
    assert.equal(events.filter(event => event === "canceled").length, 1);
    assert.equal(await convex.query(api.identity.viewer, { token }), null);
    assert.equal(uploads(), 0);
    assert.deepEqual(errors, []);
  } catch (error) {
    console.error("Sign-out state", events, page.url(), (await page.locator("body").innerText()).slice(-1500));
    throw error;
  } finally { releaseIntent?.(); await context.close(); }
});

const pageFixture = path.resolve(import.meta.dirname, "../fixtures/ticket-page");
/** Creates a text-only Ticket, deep-links to its detail and expands hosted pages. */
async function openNewTicket(f: Awaited<ReturnType<typeof open>>, role: "staff" | "customer", language: Language) {
  const name = `Pages ${role} ${crypto.randomUUID()}`;
  const created = await convex.mutation(api.tickets.createTextTicket, {
    token: f.token, projectKey: "POS", title: name, description: "Hosted page fixture", requestId: crypto.randomUUID(),
  });
  await f.page.goto(`${baseURL}/${role}?project=POS${role === "staff" ? "&view=table" : ""}&ticket=${created.ticket._id}`);
  await f.page.getByRole("heading", { name, exact: true }).waitFor();
  await f.page.getByRole("button", { name: copy(language, "pagesTitle"), exact: true }).click();
  const dialog = f.page.locator("body");
  await dialog.getByText(copy(language, role === "staff" ? "pagesHint" : "customerPagesHint"), { exact: true }).waitFor();
  return { dialog, ref: created.ticket.ticketNumber };
}
async function publishFrom(dialog: Locator, language: Language, input: "choosePageFolder" | "chooseHtmlFile", source: string, entry?: string, timeout?: number) {
  await dialog.getByLabel(copy(language, input), { exact: true }).setInputFiles(source);
  if (entry) await dialog.getByLabel(copy(language, "pageEntry"), { exact: true }).selectOption(entry);
  await dialog.getByRole("button", { name: copy(language, "publishPage"), exact: true }).click();
  const link = dialog.getByRole("link", { name: copy(language, "openPageNamed", { name: entry ?? path.basename(source) }), exact: true });
  await link.waitFor({ timeout });
  return link;
}

for (const [role, language] of [["staff", "en"], ["staff", "th"]] as const) {
  test(`staff ${language}: publish a folder page with nested assets, open it isolated, copy, revoke; publish a single file`, async () => {
    const f = await open(role, language);
    const responses = new Map<string, { status: number; type: string | null }>();
    f.context.on("response", response => { if (response.url().includes("/p/")) responses.set(new URL(response.url()).pathname, { status: response.status(), type: response.headers()["content-type"] ?? null }); });
    try {
      await f.context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });
      const { dialog } = await openNewTicket(f, role, language);
      await dialog.getByText(copy(language, "pagesEmpty"), { exact: true }).waitFor();
      const link = await publishFrom(dialog, language, "choosePageFolder", pageFixture, "reports/summary.html");
      const url = (await link.getAttribute("href"))!;
      assert.match(url, /\/p\/[A-Za-z0-9_-]{43}\/reports\/summary\.html$/);
      assert.equal(await link.getAttribute("rel"), "noopener noreferrer");

      const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
      const popupErrors = hostedPageErrors(popup);
      await popup.getByText("Inline script ran", { exact: true }).waitFor();
      await popup.getByText("External script ran", { exact: true }).waitFor();
      await popup.waitForFunction(() => (document.getElementById("shot") as HTMLImageElement).naturalWidth === 8);
      await popup.waitForFunction(() => document.fonts.status === "loaded");
      const prefix = new URL(url).pathname.replace(/reports\/summary\.html$/, "");
      const assets = [["assets/site.css", "text/css"], ["assets/app.js", "text/javascript"], ["assets/img/dot.png", "image/png"], ["assets/img/bg.png", "image/png"], ["assets/fonts/fixture.woff2", "font/woff2"]];
      // CSS backgrounds and fonts load asynchronously after the scripts run.
      for (let waited = 0; assets.some(([file]) => !responses.has(prefix + file)) && waited < 5000; waited += 50) await popup.waitForTimeout(50);
      for (const [file, type] of assets) {
        assert.equal(responses.get(prefix + file)?.status, 200, file);
        assert.match(responses.get(prefix + file)?.type ?? "", new RegExp(`^${type}`), file);
      }
      // The page runs in an opaque-origin sandbox: no app storage and no opener.
      assert.deepEqual(await popup.evaluate(() => {
        let storage = "readable";
        try { void sessionStorage.length; } catch { storage = "blocked"; }
        return { storage, opener: window.opener === null, origin: window.origin };
      }), { storage: "blocked", opener: true, origin: "null" });
      await popup.locator("#details").click();
      await popup.getByRole("heading", { name: "Fixture details", exact: true }).waitFor();
      assert.deepEqual(popupErrors, []);

      await dialog.getByRole("button", { name: copy(language, "copyLinkNamed", { name: "reports/summary.html" }), exact: true }).click();
      await f.page.waitForFunction(async expected => await navigator.clipboard.readText() === expected, url);

      await dialog.getByRole("button", { name: copy(language, "revokeLinkNamed", { name: "reports/summary.html" }), exact: true }).click();
      await f.page.getByRole("alertdialog").getByRole("button", { name: copy(language, "revokeLink"), exact: true }).click();
      await dialog.getByText(copy(language, "pagesEmpty"), { exact: true }).waitFor();
      assert.equal((await popup.goto(url))?.status(), 404);
      assert.equal((await popup.goto(new URL("../assets/img/dot.png", url).href))?.status(), 404);

      const single = await publishFrom(dialog, language, "chooseHtmlFile", path.join(pageFixture, "reports/details.html"));
      assert.match((await single.getAttribute("href"))!, /\/details\.html$/);
      assert.equal(await dialog.getByLabel(copy(language, "pageEntry"), { exact: true }).count(), 0);
      assert.equal(f.uploads(), 0);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
}

test("customer cannot choose an HTML file or folder on their Ticket", async () => {
  const f = await open("customer", "th");
  try {
    const { dialog } = await openNewTicket(f, "customer", "th");
    await dialog.getByText(copy("th", "pagesEmpty"), { exact: true }).waitFor();
    assert.equal(await dialog.getByLabel(copy("th", "choosePageFolder"), { exact: true }).count(), 0);
    assert.equal(await dialog.getByLabel(copy("th", "chooseHtmlFile"), { exact: true }).count(), 0);
  } finally { await f.context.close(); }
});

test("publishing an HTML screenshot fits Full HD and preserves transparent pixels", async () => {
  const { default: sharp } = await import("sharp");
  const source = await sharp({ create: { width: 3000, height: 300, channels: 4, background: "#1495ac80" } }).png().toBuffer();
  const html = '<img alt="Ticket screenshot" src="data:image/png;base64,' + source.toString("base64") + '">';
  const f = await open("staff");
  try {
    const { dialog } = await openNewTicket(f, "staff", "en");
    await dialog.getByLabel(copy("en", "chooseHtmlFile"), { exact: true }).setInputFiles({
      name: "screenshot.html", mimeType: "text/html", buffer: Buffer.from(html),
    });
    await dialog.getByRole("button", { name: copy("en", "publishPage"), exact: true }).click();
    const link = dialog.getByRole("link", { name: copy("en", "openPageNamed", { name: "screenshot.html" }), exact: true });
    const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
    const image = popup.getByAltText("Ticket screenshot");
    await image.evaluate(async element => { await (element as HTMLImageElement).decode(); });
    const data = await image.getAttribute("src");
    assert(data);
    const pixels = await sharp(Buffer.from(data.split(",")[1], "base64")).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([pixels.info.width, pixels.info.height, pixels.info.channels, pixels.data[3]], [1920, 192, 4, 128]);
  } finally { await f.context.close(); }
});

/**
 * Records each page publish: its image policy header and multipart payload bytes.
 * Chromium hides File-backed parts from Playwright, so the payload is summed in
 * the page from the FormData the app hands to fetch. Applies from the next navigation.
 */
async function trackPublishes(context: BrowserContext) {
  await context.addInitScript(() => {
    const send = window.fetch.bind(window);
    const sizes: number[] = [];
    Object.assign(window, { pageUploadBytes: sizes });
    window.fetch = (input, init) => {
      if (init?.body instanceof FormData && String(input).includes("/pages")) {
        let bytes = 0;
        init.body.forEach(value => { bytes += typeof value === "string" ? new TextEncoder().encode(value).length : value.size; });
        sizes.push(bytes);
      }
      return send(input, init);
    };
  });
  const requests: Request[] = [];
  context.on("request", request => { if (request.method() === "POST" && /\/v1\/tickets\/[^/]+\/pages$/.test(new URL(request.url()).pathname)) requests.push(request); });
  return async (page: Page) => {
    const sizes = await page.evaluate(() => (window as unknown as { pageUploadBytes: number[] }).pageUploadBytes);
    return requests.map((request, index) => ({ bytes: sizes[index], policy: request.headers()["x-ticket-image-policy"] ?? null }));
  };
}

test("originals over the request limit are prepared in the browser and stay within Full HD", { timeout: 120_000 }, async () => {
  const { default: sharp } = await import("sharp");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const folder = await mkdtemp(path.join(tmpdir(), "ticket-page-large-"));
  // Uncompressed noise: 2200 × 1800 RGBA is about 15.8 MB, over the 10 MiB page limit.
  const photo = await sharp({ create: { width: 2200, height: 1800, channels: 4, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 50 } } }).png({ compressionLevel: 0 }).toBuffer();
  await writeFile(path.join(folder, "index.html"), '<img alt="Large photo" src="photo.png">');
  await writeFile(path.join(folder, "photo.png"), photo);
  const f = await open("staff");
  const publishes = await trackPublishes(f.context);
  try {
    assert.ok(photo.length > 10 * 1024 * 1024);
    const { dialog } = await openNewTicket(f, "staff", "en");
    await dialog.getByLabel(copy("en", "choosePageFolder"), { exact: true }).setInputFiles(folder);
    await dialog.getByRole("button", { name: copy("en", "publishPage"), exact: true }).click();
    const link = dialog.getByRole("link", { name: copy("en", "openPageNamed", { name: "index.html" }), exact: true });
    await link.waitFor({ timeout: 60_000 });
    const posts = await publishes(f.page);
    assert.deepEqual(posts.map(post => post.policy), ["v1"]);
    assert.ok(posts[0].bytes < photo.length / 2, `request ${posts[0].bytes} bytes`);
    const stored = Buffer.from(await (await fetch(new URL("photo.png", (await link.getAttribute("href"))!))).arrayBuffer());
    const meta = await sharp(stored).metadata();
    assert.deepEqual([meta.width, meta.height], [1320, 1080]);
    assert.deepEqual(f.errors, []);
  } finally { await f.context.close(); await rm(folder, { recursive: true, force: true }); }
});

/** Every literal base64 `img src` in served HTML, decoded with its stored format. */
async function embeddedImages(html: string) {
  const { default: sharp } = await import("sharp");
  return await Promise.all([...html.matchAll(/<img\b[^>]*?\ssrc="data:(image\/[a-z]+);base64,([^"]+)"/g)].map(async ([, type, base64]) => {
    const bytes = Buffer.from(base64, "base64");
    const meta = await sharp(bytes).metadata();
    return { type, bytes, size: bytes.length, width: meta.width!, height: meta.height!, alpha: Boolean(meta.hasAlpha) };
  }));
}

// The real Thai report (1.4 MB, nine embedded screenshots, zoom dialog) when present locally.
// PAGE_SAMPLE_EVIDENCE names a JSON file that receives per-image sizes and formats.
const sampleHtml = process.env.PAGE_SAMPLE_HTML;
test("staff: the real sample page publishes, renders every screenshot and opens its zoom dialog", { timeout: 120_000, skip: !sampleHtml && "PAGE_SAMPLE_HTML is not set" }, async () => {
  const { default: sharp } = await import("sharp");
  const { faithfulPixels, fitImage } = await import("../../shared/image-optimization");
  const { readFile, writeFile } = await import("node:fs/promises");
  const f = await open("staff");
  const publishes = await trackPublishes(f.context);
  try {
    const { dialog } = await openNewTicket(f, "staff", "en");
    const started = Date.now();
    const link = await publishFrom(dialog, "en", "chooseHtmlFile", sampleHtml!, undefined, 90_000);
    const publishMs = Date.now() - started;
    const url = (await link.getAttribute("href"))!;
    const [popup] = await Promise.all([f.context.waitForEvent("page"), link.click()]);
    const popupErrors = hostedPageErrors(popup);
    await popup.waitForLoadState("load");
    const shots = popup.locator("button.shot img");
    assert.equal(await shots.count(), 9);
    await popup.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("button.shot img")].every(image => image.complete && image.naturalWidth > 0));
    await popup.locator("button.shot").first().click();
    await popup.waitForFunction(() => (document.getElementById("zoom") as HTMLDialogElement).open);
    await popup.locator("#zclose").click();
    await popup.waitForFunction(() => !(document.getElementById("zoom") as HTMLDialogElement).open);
    assert.deepEqual(popupErrors, []);
    assert.deepEqual(f.errors, []);

    const source = await readFile(sampleHtml!);
    const served = Buffer.from(await (await fetch(url)).arrayBuffer());
    const before = await embeddedImages(source.toString("utf8"));
    const after = await embeddedImages(served.toString("utf8"));
    assert.equal(after.length, before.length);
    const images = await Promise.all(after.map(async (output, index) => {
      const original = before[index];
      const fitted = fitImage(original.width, original.height);
      // Full HD bounds, aspect and alpha hold; pixels pass the same comparison the encoder used.
      assert.deepEqual([output.width, output.height], [fitted.width, fitted.height], `image ${index} size`);
      assert.equal(output.alpha && !original.alpha ? "alpha added" : "ok", "ok", `image ${index} alpha`);
      const reference = await sharp(original.bytes).rotate().resize(fitted.width, fitted.height, { fit: "fill" }).ensureAlpha().raw().toBuffer();
      const pixels = await sharp(output.bytes).ensureAlpha().raw().toBuffer();
      return { index, from: original.type, to: output.type, beforeBytes: original.size, afterBytes: output.size,
        width: output.width, height: output.height, faithful: faithfulPixels(reference, pixels) };
    }));
    assert.ok(images.every(image => image.faithful), "every stored image passes the pixel comparison");
    const posts = await publishes(f.page);
    assert.equal(posts.length, 1, "one publish request");
    assert.equal(posts[0].policy, null, "originals within the limits go to the server pipeline");
    assert.ok(posts[0].bytes >= source.length, "the original HTML is sent unchanged");
    assert.ok(served.length < source.length, "the server stores a smaller page");
    const evidence = { source: { bytes: source.length }, served: { bytes: served.length, savedPercent: +(100 * (1 - served.length / source.length)).toFixed(1) },
      request: posts[0], publishMs, converted: images.filter(image => image.from !== image.to).length, images };
    console.log("PAGE_SAMPLE_EVIDENCE " + JSON.stringify({ ...evidence, images: undefined }));
    if (process.env.PAGE_SAMPLE_EVIDENCE) await writeFile(process.env.PAGE_SAMPLE_EVIDENCE, JSON.stringify(evidence, null, 2));
  } finally { await f.context.close(); }
});

for (const role of ["staff", "customer"] as const) {
  test(`${role}: thumbnail pencil renames the attachment beside its filename`, async () => {
    const device = role === "customer" ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {};
    const { context, page, title, errors, uploads } = await openWith(await browsers.get(), role, "en", undefined, device);
    const button = (name: string) => page.getByRole("button", { name, exact: true });
    try {
      await title.fill("Payment screen freezes");
      await files(page, "checkout.png");
      const rename = button("Rename checkout.png");
      assert.equal(await rename.textContent(), "");
      assert.equal(await rename.locator("svg.lucide-pencil").count(), 1);
      assert.equal(await button("Use suggestion").count(), 0);
      await rename.click();
      const field = page.getByRole("textbox", { name: "File name", exact: true });
      await button("Use suggestion").click();
      assert.equal(await field.inputValue(), "Payment screen freezes - Photo 1");
      await field.fill("Checkout error.png");
      await field.press("Enter");
      await button("Rename Checkout error.png").waitFor();
      await button(copy("en", "composerPreview")).click();
      const review = page.getByRole("region", { name: copy("en", "composerPreview") });
      assert.equal(await review.getByText("Checkout error.png", { exact: true }).count(), 1);
      await button("Rename Checkout error.png").click();
      await button("Restore original").click();
      await rename.waitFor();
      assert.equal(uploads(), 0);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
}
