// Run from any directory with pnpm exec node /path/to/verify-preview.mjs.
// The browser uses only the local HTML file and fictional Tickets.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const preview = new URL("./ux-architecture-preview.html", import.meta.url).href;
const browser = await chromium.launch();
const failures = [];

async function verify(name, run) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  const errors = [];
  page.setDefaultTimeout(4000);
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(preview);
    await run(page);
    assert.deepEqual(errors, []);
    console.log("PASS", name);
  } catch (error) {
    failures.push(name);
    console.error("FAIL", name, error.message);
  } finally {
    await page.close();
  }
}

const staff = page => page.locator('[data-page="staff"]').click();
const customer = page => page.locator('[data-page="customer"]').click();
const open = (page, id) => page.locator('[data-open="' + id + '"]').first().click();
const show = async (page, name) => {
  const section = page.locator('[data-section="' + name + '"]');
  if (!(await section.evaluate(element => element.open))) await section.locator("summary").click();
};
const order = page => page.locator("[data-open]").evaluateAll(elements => elements.map(el => el.dataset.open));
const title = page => page.locator("#detail-heading").innerText();
const submit = page => page.locator('#create-form button[type="submit"]').click();

async function countActivations(page, task) {
  await page.evaluate(() => {
    window.taskActivations = 0;
    document.addEventListener("click", event => {
      if (event.target.closest("button, summary")) window.taskActivations++;
    }, true);
  });
  await task();
  return page.evaluate(() => window.taskActivations);
}

async function inspectLayout(page, width, context) {
  const result = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("button,select,input,textarea,summary")]
      .filter(el => el.checkVisibility() && el.getClientRects().length);
    return {
      overflow: document.documentElement.scrollWidth - innerWidth,
      undersized: controls.filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width < 43.99 || rect.height < 43.99;
      }).map(el => el.outerHTML.slice(0, 120)),
    };
  });
  assert.ok(result.overflow <= 1, width + "px " + context + " overflows by " + result.overflow);
  assert.deepEqual(result.undersized, [], width + "px " + context + " touch targets");
}

try {
  await verify("Customer creates a text-only Ticket in two activations", async page => {
    await customer(page);
    const activations = await countActivations(page, async () => {
      await page.locator("[data-new]").click();
      await page.locator("#new-title").fill("Receipt lookup");
      await submit(page);
    });
    assert.equal(await title(page), "Receipt lookup");
    assert.equal(activations, 2);
  });

  await verify("Three distinct Tickets take three activations", async page => {
    const titles = new Set();
    const activations = await countActivations(page, async () => {
      await open(page, "POS-0042");
      titles.add(await title(page));
      for (let i = 0; i < 2; i++) {
        await page.getByRole("button", { name: /Next/ }).click();
        titles.add(await title(page));
      }
    });
    assert.equal(titles.size, 3);
    assert.equal(activations, 3);
  });

  await verify("One-action staff triage and role-scoped Undo", async page => {
    const move = page.locator('[data-move="POS-0042"]');
    assert.equal(await countActivations(page, () => move.click()), 1);
    assert.match(await page.locator('[data-open="POS-0042"]').innerText(), /Acknowledged/);
    await page.locator("#undo").click();
    assert.match(await page.locator('[data-open="POS-0042"]').innerText(), /New/);
    await move.click();
    await customer(page);
    assert.equal(await page.locator("#undo:visible, [data-move], [data-open='POS-0041']").count(), 0);
  });

  await verify("Filtered Ticket survives reload, Back and Forward", async page => {
    await page.locator("#search").fill("scanner");
    await open(page, "POS-0041");
    await page.reload();
    assert.match(await title(page), /Scanner/);
    await page.goBack();
    assert.equal(await page.locator("#detail-heading").count(), 0);
    assert.equal(await page.locator("#search").inputValue(), "scanner");
    await page.goForward();
    assert.match(await title(page), /Scanner/);
    const unauthorized = new URL(page.url());
    unauthorized.searchParams.set("role", "customer");
    await page.goto(unauthorized.href);
    assert.equal(await page.locator("#detail-heading").count(), 0);
    assert.match(await page.locator("main").innerText(), /unavailable/i);
  });

  await verify("Focus exits to the list and urgency preserves queue order", async page => {
    const initial = await order(page);
    await page.locator("#view").selectOption("focus");
    if (!(await page.locator("#detail-heading").count())) await open(page, initial[0]);
    await page.locator("[data-back]").click();
    assert.equal(await page.locator("#detail-heading").count(), 0);
    await open(page, initial[0]);
    await show(page, "properties");
    await page.locator("#urgency").fill("1");
    await page.locator("#urgency-form button").first().click();
    await page.locator("[data-back]").click();
    assert.deepEqual(await order(page), initial);
    await page.locator("#workspace-menu summary").click();
    await page.locator("[data-refresh]").click();
    assert.notDeepEqual(await order(page), initial);
  });

  await verify("Separate customer and staff edit drafts", async page => {
    await open(page, "POS-0042");
    await page.locator("[data-edit]").click();
    await page.locator("#edit-description").fill("Unsaved staff note");
    await customer(page);
    await open(page, "POS-0042");
    await page.locator("[data-edit]").click();
    assert.notEqual(await page.locator("#edit-description").inputValue(), "Unsaved staff note");
    await staff(page);
    if (!(await page.locator("#edit-description").count())) await page.locator("[data-edit]").click();
    assert.equal(await page.locator("#edit-description").inputValue(), "Unsaved staff note");
  });

  await verify("Keyboard pin placement and retry preserve the submission", async page => {
    await page.locator('[data-page="plan"]').click();
    await page.getByText("Preview controls", { exact: true }).click();
    await page.locator("[data-test-retry]").click();
    await customer(page);
    await page.locator("[data-new]").click();
    await submit(page);
    assert.equal(await page.locator("#new-title").evaluate(el => el === document.activeElement), true);
    await page.locator("#new-title").fill("Keyboard sample");
    await page.locator("[data-sample]").press("Enter");
    await page.locator('[data-add-pin="draft"]').press("Enter");
    await page.locator("#pin-note").fill("Receipt total");
    const slider = page.locator("#pin-x");
    const before = Number(await slider.inputValue());
    await slider.press("ArrowRight");
    assert.equal(Number(await slider.inputValue()), before + 1);
    await page.locator("[data-save-pin]").press("Enter");
    await page.keyboard.press("Escape");
    await page.locator("[data-new]").press("Enter");
    assert.equal(await page.locator("#new-title").inputValue(), "Keyboard sample");
    await submit(page);
    assert.ok(await page.locator("#submit-error").isVisible());
    assert.match(await page.locator("#create-form").innerText(), /Receipt total/);
    await submit(page);
    assert.equal(await title(page), "Keyboard sample");
    await show(page, "media");
    assert.match(await page.locator("[data-section=media]").innerText(), /Receipt total/);
  });

  await verify("Request, reply and explicit resume keep the right role in control", async page => {
    await open(page, "POS-0042");
    await show(page, "conversation");
    await page.locator("#message-text").fill("Which register?");
    await page.locator("#message-form button").click();
    await customer(page);
    await open(page, "POS-0042");
    await show(page, "conversation");
    assert.match(await page.locator("#message-form").locator("..").innerText(), /Which register/);
    await page.locator("#message-text").fill("Register two.");
    await page.locator("#message-form button").click();
    assert.match(await page.locator(".detail .status").innerText(), /Waiting/);
    await staff(page);
    await page.locator('.detail [data-move="POS-0042"]').click();
    assert.match(await page.locator(".detail .status").innerText(), /In progress/);
  });

  await verify("Deletion confirmation and staff restoration", async page => {
    await customer(page);
    await open(page, "POS-0042");
    await show(page, "more");
    await page.locator("[data-delete]").click();
    await page.locator("#keep").press("Enter");
    assert.match(await title(page), /Receipt/);
    await page.locator("[data-delete]").click();
    await page.locator("#confirm").click();
    assert.equal(await page.locator('[data-open="POS-0042"], #undo:visible').count(), 0);
    await staff(page);
    await page.locator("#filter").selectOption("archive");
    await open(page, "POS-0042");
    assert.equal(await page.locator(".detail [data-move], .detail [data-edit], .detail #urgency").count(), 0);
    await page.locator(".detail [data-restore]").click();
    await customer(page);
    assert.ok(await page.locator('[data-open="POS-0042"]').isVisible());
  });

  await verify("A conflicting edit preserves both versions for a decision", async page => {
    await open(page, "POS-0042");
    await page.locator("[data-edit]").click();
    await page.locator("#edit-description").fill("Staff draft, held for review");
    await customer(page);
    await open(page, "POS-0042");
    await page.locator("[data-edit]").click();
    await page.locator("#edit-description").fill("Updated by the customer");
    await page.locator("#edit-form button[type=submit], #edit-form button.primary").first().click();
    await staff(page);
    if (!(await page.locator("#edit-description").count())) await page.locator("[data-edit]").click();
    await page.locator("#edit-form button.primary").click();
    assert.match(await page.locator("#edit-conflict").innerText(), /Updated by the customer/);
    assert.equal(await page.locator("#edit-description").inputValue(), "Staff draft, held for review");
    await page.getByRole("button", { name: "Use saved details" }).click();
    assert.match(await page.locator(".description").innerText(), /Updated by the customer/);
  });

  await verify("Keyboard-only traversal, activation and focus return", async page => {
    const tabTo = async selector => {
      for (let i = 0; i < 65; i++) {
        if (await page.evaluate(selector => document.activeElement.matches(selector), selector)) return;
        await page.keyboard.press("Tab");
      }
      assert.fail("Tab could not reach " + selector);
    };
    await tabTo('[data-open="POS-0042"]');
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#detail-heading").evaluate(el => el === document.activeElement), true);
    await tabTo('.detail [data-move="POS-0042"]');
    await page.keyboard.press("Space");
    assert.match(await page.locator(".detail .status").innerText(), /Acknowledged/);
    await tabTo("#undo");
    await page.keyboard.press("Enter");
    assert.match(await page.locator(".detail .status").innerText(), /New/);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator('[data-open="POS-0042"]').evaluate(el => el === document.activeElement), true);
  });

  await verify("Saved pin selection, search announcement and language choice", async page => {
    await page.locator("#search").fill("Receipt total");
    await page.waitForFunction(() => document.querySelector("#result-announcement").textContent.startsWith("1 matching Ticket"));
    assert.equal(await page.locator("#search").evaluate(el => el === document.activeElement), true);
    await page.locator('[data-media="POS-0042"]').click();
    const pin = page.locator('[data-saved-pin="0"]');
    await pin.press("Enter");
    assert.equal(await pin.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".selected-point").textContent(), "1");
    await page.locator("[data-back]").click();
    await page.locator("#workspace-menu summary").click();
    await page.locator("[data-account]").click();
    await page.locator("#account-language").selectOption("th");
    assert.equal(await page.locator("#heading").innerText(), "บัญชี");
    await page.locator("[data-signout]").click();
    assert.ok(await page.getByText("รหัสผ่าน", { exact: true }).isVisible());
    await page.locator("#password").fill("demo input");
    await page.locator("#account-language").selectOption("en");
    assert.equal(await page.locator("#password").inputValue(), "demo input");
    assert.ok(await page.getByText("Password", { exact: true }).isVisible());
  });

  await verify("Layout and target sizes at six widths", async page => {
    for (const width of [320, 390, 640, 728, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(preview);
      await inspectLayout(page, width, "list");
      await open(page, "POS-0042");
      await inspectLayout(page, width, "detail");
      await page.locator("[data-back]").click();
      await page.locator("[data-new]").click();
      await inspectLayout(page, width, "composer");
    }
  });
} finally {
  await browser.close();
}
assert.deepEqual(failures, [], "Prototype scenarios that need attention");
