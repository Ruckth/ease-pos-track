import assert from "node:assert/strict";

/** Exercise the shared URL in both screen sizes. Leave the bilingual example open for staff. */
export default async function captureSmoke({ page, width, stable, checkWrites }) {
  await page.goto(`${stable}/staff/settings/line?project=POS`);
  const dialog = page.getByRole("dialog", { name: "LINE", exact: true });
  const sample = dialog.getByRole("listitem").filter({ hasText: "Receipt preview cuts off the total" }).first();
  const served = page.waitForResponse(response => response.url().includes("/v1/line-capture/media/")
    && response.request().method() === "GET" && response.ok());
  await sample.getByRole("button", { name: "Review intake" }).press("Enter");
  const privateImage = await served;
  assert.match(privateImage.headers()["cache-control"], /no-store/);
  const anonymous = await page.request.get(privateImage.url());
  assert.ok([401, 403, 404].includes(anonymous.status()), "Screenshot requires current staff authorization");
  for (const index of [1, 2]) {
    const image = sample.getByRole("img", { name: `Staged screenshot ${index}` });
    await image.waitFor();
    await image.evaluate(element => element.decode());
    assert.ok(await image.evaluate(element => element.naturalWidth > 0 && element.src.startsWith("blob:")));
  }
  assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Review must fit on screen");

  const creating = width > 400;
  const source = creating ? "Training checkout displayed the wrong subtotal" : "Training printer repeated the receipt";
  const row = dialog.getByRole("listitem").filter({ hasText: source }).first();
  if (checkWrites && await row.count()) {
    await row.getByRole("button", { name: "Review intake" }).click();
    if (creating) {
      await row.getByLabel("Topic", { exact: true }).fill(source);
      await row.getByLabel("Description (optional)", { exact: true }).fill("Observed in the keyless LINE rehearsal");
      await row.getByRole("button", { name: "Create Ticket", exact: true }).click();
    } else {
      await row.getByRole("combobox").selectOption("link");
      await row.getByLabel("Ticket reference").fill("POS-0001");
      await row.getByText(/POS-0001 · Printer needs review/).waitFor();
      await row.getByRole("button", { name: "Link to Ticket", exact: true }).click();
    }
    await dialog.getByRole("status").filter({ hasText: /Linked to POS-\d+/ }).waitFor();
  }
  if (checkWrites) {
    await dialog.getByRole("button", { name: "History", exact: true }).click();
    await dialog.getByRole("listitem").filter({ hasText: source }).first().getByText(/Linked to POS-\d+/).waitFor();
  }
}
