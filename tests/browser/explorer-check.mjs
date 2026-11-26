// Run with tsx (pnpm test:browser does): the evidence helpers are TypeScript.
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";
import { capture, EVIDENCE_DIR, newContext, recordChromium } from "../../scripts/browser-evidence.ts";
const browser = await chromium.launch({ headless: true });
recordChromium(browser.version());
const shot = name => path.join(EVIDENCE_DIR, "public", "screenshots", `explorer-${name}.png`);
let page;
const errors=[];
const button = name => page.getByRole("button", { name, exact: true });
const countRows = async n => { await page.waitForFunction(n => document.querySelectorAll('tbody tr').length === n,n); };
const summary = async text => { await page.getByText(text,{exact:true}).waitFor(); };
async function add(field, operator) {
  await button("Add filter").click();
  await page.getByRole("option", { name: field, exact: true }).click();
  await page.getByRole("option", { name: operator, exact: true }).click();
}
try { await capture("explorer", "Ticket Explorer harness", async () => {
  const context = await newContext(browser, { viewport: { width: 1440, height: 1000 } });
  page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:5193"}/tests/browser/explorer.html`);
  await button("Language").click(); await button("Table").click(); await countRows(10);
  await button("Next page").click(); await summary("Page 2 of 6 · 54 Tickets");
  await page.getByRole("combobox",{name:"Rows per page"}).selectOption("25"); await countRows(25); await summary("Page 1 of 3 · 54 Tickets");
  await button("Last page").click(); await countRows(4);
  await button("Ticket number").click(); await countRows(25);
  assert.match(await page.locator("tbody tr").first().innerText(),/POS-0001/);
  await page.getByRole("button",{name:/Open Ticket POS-0001:/}).click(); assert.equal(await page.locator("output").innerText(),"0");
  await add("Tags","is any of"); await page.getByRole("option",{name:"Printer",exact:true}).click(); await page.keyboard.press("Escape"); await summary("Page 1 of 2 · 27 Tickets");
  await button("Board").click(); assert.equal(await button("Board").getAttribute("aria-pressed"),"true");
  await button("Table").click(); await summary("Page 1 of 2 · 27 Tickets");
  await add("Status","is any of"); await page.getByRole("option",{name:"Resolved",exact:true}).click(); await page.keyboard.press("Escape"); await countRows(9);
  await button("Status filter options").click(); await page.getByRole("menuitem",{name:"Remove",exact:true}).click(); await summary("Page 1 of 2 · 27 Tickets");
  await button("Clear all").click(); await countRows(25);
  await add("Created date","between");
  await page.getByLabel("Created date · From",{exact:true}).fill("2026-09-15");
  await page.getByLabel("Created date · Through",{exact:true}).fill("2026-09-16");
  await button("Apply").click(); await countRows(2);
  await button("Clear all").click();
  await add("Urgency","Unset"); await countRows(14);
  await button("Clear all").click();
  await add("Urgency","between");
  const slider=page.getByRole("slider").first(); await slider.focus(); await page.keyboard.press("End");
  await button("Apply").click(); await page.getByText("No Tickets match these filters.",{exact:true}).waitFor();
  await button("Clear all").click();
  await button("Archives").click(); await summary("Page 1 of 3 · 55 Tickets");
  await page.getByRole("textbox",{name:"Search",exact:true}).fill("POS-0055"); await countRows(1); assert.match(await page.locator("tbody").innerText(),/Archived/);
  await page.getByRole("button",{name:/Open Ticket POS-0055:/}).click();
  const archivedDialog=page.getByRole("dialog"); await archivedDialog.waitFor();
  assert.equal(await archivedDialog.getByRole("button",{name:"Edit",exact:true}).count(),0);
  await archivedDialog.getByRole("button",{name:"Restore",exact:true}).click(); await archivedDialog.waitFor({state:"hidden"});
  assert.doesNotMatch(await page.locator("tbody").innerText(),/Archived/);
  await button("Clear all").click(); await button("Last page").click(); await button("Shrink").click(); await summary("Page 1 of 1 · 5 Tickets");
  assert.equal(await button("Next page").isDisabled(),true);
  await page.screenshot({path:shot("desktop"),fullPage:true});
  await button("Language").click(); await button("เพิ่มตัวกรอง").click();
  await page.getByRole("option",{name:"สถานะ",exact:true}).click(); await page.getByRole("option",{name:"ตรงกับรายการใดก็ได้",exact:true}).click(); await page.keyboard.press("Escape");
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:shot("mobile"),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true,"no horizontal page overflow");
  // A populated phone Table keeps its sort and primary action within reach.
  await button("Language").click();
  await page.getByRole("combobox", { name: "Sort", exact: true }).selectOption("ticketNumber:asc");
  assert.equal(await page.getByRole("table").count(), 0, "only the compact Table is mounted");
  await button("Acknowledge · POS-0002").click();
  await button("Start work · POS-0002").waitFor();
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.getByRole("table").waitFor();
  await button("Start work · POS-0002").waitFor();

  const board = page.getByRole("region", { name: "Board", exact: true });
  const lane = status => board.locator(`[data-slot="kanban-column"][data-value="${status}"]`);
  const shortcuts = page.getByRole("group", { name: "Show tickets by status" });
  const shortcut = name => shortcuts.getByRole("button", { name, exact: true });
  async function expectPhoneShortcuts(group, labels) {
    assert.equal(await group.getByRole("button").count(), labels.length);
    const boxes = await Promise.all(labels.map(async ([name, visibleLabel = name]) => {
      const control = group.getByRole("button", { name, exact: true });
      assert.equal(await control.innerText(), visibleLabel);
      return control.boundingBox();
    }));
    const strip = await group.boundingBox();
    assert.ok(strip && boxes.every(box => box && box.width >= 44 && box.height >= 44 && Math.abs(box.y - boxes[0].y) < 1));
    assert.ok(boxes.every(box => box.x >= strip.x - 1 && box.x + box.width <= strip.x + strip.width + 1), "each shortcut is fully visible without scrolling the strip");
  }

  await page.setViewportSize({ width: 1440, height: 1000 });
  // A constrained search keeps this standalone harness independent of Convex.
  await page.getByRole("textbox", { name: "Search", exact: true }).fill("Ticket");
  await button("Board").click();
  await lane("new").waitFor();
  assert.equal(await board.locator('[data-slot="kanban-column"]').count(), 5);
  assert.equal(await board.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  assert.equal(await shortcuts.count(), 0);
  const drag = lane("new").getByRole("button", { name: "Drag ticket POS-0005", exact: true });
  const source = await drag.boundingBox();
  const destination = await lane("waiting").boundingBox();
  assert.ok(source && destination);
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x + destination.width / 2, destination.y + 72, { steps: 20 });
  await page.mouse.up();
  await lane("waiting").locator("button[data-ticket-id='4']").waitFor();
  assert.equal(await lane("new").locator("button[data-ticket-id='4']").count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await shortcut("New").click();
  const englishShortcuts = [["New"], ["Acknowledged", "Ack."], ["In progress"], ["Waiting for customer", "Waiting"], ["Resolved"]];
  await expectPhoneShortcuts(shortcuts, englishShortcuts);
  assert.equal(await board.locator('[data-slot="kanban-column"]').count(), 5);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await board.getByRole("button", { name: /Drag ticket/ }).count(), 0);
  const viewport = await board.boundingBox();
  const adjacent = await lane("acknowledged").boundingBox();
  assert.ok(viewport && adjacent && adjacent.x < viewport.x + viewport.width && adjacent.x + adjacent.width > viewport.x + viewport.width);
  await shortcut("Waiting for customer").focus();
  await page.keyboard.press("Enter");
  await shortcut("Waiting for customer").and(page.locator('[aria-pressed="true"]')).waitFor();
  assert.equal(await lane("waiting").evaluate(el => Math.abs(el.getBoundingClientRect().left - el.closest('[role="region"]').getBoundingClientRect().left) < 2), true);
  await board.evaluate(el => { el.scrollLeft = 0; });
  await shortcut("New").and(page.locator('[aria-pressed="true"]')).waitFor();
  await page.screenshot({ path: shot("board-mobile"), fullPage: true });
  await page.setViewportSize({ width: 320, height: 720 });
  await expectPhoneShortcuts(shortcuts, englishShortcuts);
  await button("Language").click();
  await expectPhoneShortcuts(page.getByRole("group", { name: "แสดงรายการตามสถานะ" }), [["ใหม่"], ["รับเรื่องแล้ว", "รับเรื่อง"], ["กำลังดำเนินการ"], ["รอข้อมูลลูกค้า", "รอข้อมูล"], ["แก้ไขแล้ว"]]);
  await button("Language").click();

  // Browse counts and capped indexed search have different denominators.
  await page.goto(`${process.env.BROWSER_BASE_URL ?? "http://127.0.0.1:5193"}/tests/browser/explorer.html?partial`);
  await page.setViewportSize({ width: 390, height: 844 });
  await button("High or critical").click();
  await summary("2 matching among 20 loaded · 80 total");
  await lane("new").getByRole("button", { name: "Load older Tickets", exact: true }).click();
  await summary("4 matching among 40 loaded · 80 total");
  const search = page.getByRole("textbox", { name: "Search", exact: true });
  await search.fill("Printer");
  await summary("5 shown from the first 50 matches · Refine search");
  await page.locator('[data-slot="kanban-board"]').waitFor();
  await button("Table").click();
  await summary("5 shown from the first 50 matches · Refine search");
  assert.equal(await page.locator("[data-ticket-id]").count(), 5);
  await button("High or critical").click();
  await summary("50 shown from the first 50 matches · Refine search");
  await search.fill("POS-0002");
  await button("Board").click();
  await lane("new").getByRole("button", { name: "Acknowledge · POS-0002", exact: true }).click();
  await shortcut("Acknowledged").click();
  await lane("acknowledged").getByRole("button", { name: "Start work · POS-0002", exact: true }).waitFor();
  assert.deepEqual(errors,[]); console.log("Explorer browser checks passed: table, board, filters, dates, urgency, pagination, archives, details, Thai and mobile.");
}); } catch (error) { console.error(error); process.exitCode = 1; } finally { await browser.close(); }
