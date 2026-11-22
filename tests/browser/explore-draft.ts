// Seeded, replayable exploration of a synthetic customer Ticket draft.
// A small PRNG picks supported actions (title, add, reorder, remove, pin,
// media dialog Escape, close/resume, Project switch); after every action the
// draft is checked against a model. A failing run writes its seed, config,
// resolved action sequence and first failure to explore/<name>.json, plus the
// usual screenshot (and local trace), so it can be replayed exactly and turned
// into a deterministic regression in workflows.test.ts.
//
// Environment (all optional):
//   EXPLORE_SEEDS=1,2,3      seeds to run          EXPLORE_ACTIONS=20  actions per seed
//   EXPLORE_BUDGET_MS=90000  wall-clock budget per seed (stops starting actions)
//   EXPLORE_REPLAY=<file>    replay a recorded sequence instead of generating one
//   EXPLORE_PROBE=leak       synthetic fault: preview URLs are never revoked
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { capture, EVIDENCE_DIR, readManifest } from "../../scripts/browser-evidence";
import { copy, files, launch, open, stats } from "./harness";

type Action =
  | { kind: "title" } | { kind: "add"; name: string } | { kind: "remove"; index: number }
  | { kind: "reorder"; index: number; to: number } | { kind: "pin"; index: number } | { kind: "escape"; index: number }
  | { kind: "close" } | { kind: "resume" } | { kind: "switch"; project: "POS" | "APP" };
type Model = { files: string[]; pins: Record<string, number>; open: boolean; project: "POS" | "APP"; added: number; titled: boolean };
type Sequence = { version: 1; commit: string; seed: number | null; probe: string | null; config: { actions: number; budgetMs: number }; fixture: string; actions: Action[]; failure?: { step: number; message: string } };

const FIXTURE = "seed:run largeDataset · customer alice@local.test · Projects POS and APP · generated 320x240 PNGs";
const CAPTURED = "Point of Sale (POS)";
const language = "en" as const;
const env = process.env;
const config = { actions: Number(env.EXPLORE_ACTIONS ?? 20), budgetMs: Number(env.EXPLORE_BUDGET_MS ?? 90_000) };
const probe = env.EXPLORE_PROBE ?? null;

function mulberry32(seed: number) {
  let state = seed >>> 0;
  return () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Picks one action that is valid for the model; the first action names the draft so it captures POS. */
function choose(model: Model, random: () => number): Action {
  if (!model.titled) return { kind: "title" };
  const pick = (count: number) => Math.floor(random() * count);
  if (!model.open) return random() < 0.4 ? { kind: "switch", project: model.project === "POS" ? "APP" : "POS" } : { kind: "resume" };
  const options: Action[] = [{ kind: "close" }];
  if (model.files.length < 4) options.push({ kind: "add", name: `f${model.added + 1}.png` }, { kind: "add", name: `f${model.added + 1}.png` });
  if (model.files.length) options.push({ kind: "remove", index: pick(model.files.length) }, { kind: "pin", index: pick(model.files.length) }, { kind: "escape", index: pick(model.files.length) });
  if (model.files.length >= 2) options.push({ kind: "reorder", index: pick(model.files.length), to: pick(model.files.length) });
  return options[pick(options.length)];
}

async function apply(page: Page, model: Model, action: Action) {
  const composer = page.getByRole("dialog", { name: copy(language, "newTicket"), exact: true });
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  switch (action.kind) {
    case "title":
      await page.locator("#customer-ticket-title").fill("Exploration draft");
      model.titled = true; return;
    case "add":
      await files(page, action.name);
      await button(copy(language, "removeFile", { name: action.name })).waitFor();
      model.files.push(action.name); model.added++; return;
    case "remove": {
      const name = model.files[action.index];
      await button(copy(language, "removeFile", { name })).click();
      if (model.pins[name]) await page.getByRole("alertdialog").getByRole("button", { name: copy(language, "removeMedia"), exact: true }).click();
      await button(copy(language, "removeFile", { name })).waitFor({ state: "detached" });
      model.files.splice(action.index, 1); delete model.pins[name]; return;
    }
    case "reorder": {
      const name = model.files[action.index];
      await button(copy(language, "reorderFile", { name })).press("Enter");
      await page.getByRole("group", { name: copy(language, "filePosition", { name }), exact: true }).getByRole("button", { name: String(action.to + 1), exact: true }).press("Enter");
      model.files.splice(action.index, 1); model.files.splice(action.to, 0, name); return;
    }
    case "pin": {
      const name = model.files[action.index];
      await button(copy(language, "openMedia", { name })).click();
      const media = page.getByRole("dialog", { name, exact: true });
      await media.getByRole("button", { name: copy(language, "addPin"), exact: true }).click();
      // Existing 36 px markers intercept clicks, so each pin gets its own grid cell.
      const count = model.pins[name] ?? 0;
      await media.locator("img").first().click({ position: { x: 40 + 70 * (count % 4), y: 40 + 60 * (Math.floor(count / 4) % 3) } });
      await page.getByPlaceholder(copy(language, "describeIssue")).fill(`Pin on ${name}`);
      await media.getByRole("button", { name: copy(language, "savePin"), exact: true }).click();
      await media.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await media.waitFor({ state: "hidden" });
      model.pins[name] = (model.pins[name] ?? 0) + 1; return;
    }
    case "escape": {
      const name = model.files[action.index];
      const trigger = button(copy(language, "openMedia", { name }));
      await trigger.click();
      const media = page.getByRole("dialog", { name, exact: true });
      await media.waitFor();
      await page.keyboard.press("Escape");
      await media.waitFor({ state: "hidden" });
      await page.waitForFunction(element => element === document.activeElement, await trigger.elementHandle(), { timeout: 2000 })
        .catch(() => { throw new Error(`property focus-return: Escape from ${name} did not return focus to its file`); });
      return;
    }
    case "close":
      await composer.getByRole("button", { name: copy(language, "closeDialog"), exact: true }).click();
      await composer.waitFor({ state: "hidden" }); model.open = false; return;
    case "resume":
      await page.getByRole("button", { name: copy(language, "resumeTicket"), exact: true }).first().click();
      await composer.waitFor();
      // The dialog can open before its lazy media field has rendered.
      if (model.files.length) {
        await composer.getByRole("button", { name: copy(language, "openMedia", { name: model.files[0] }), exact: true }).waitFor();
      }
      model.open = true; return;
    case "switch":
      await page.getByRole("combobox", { name: "Choose Project", exact: true }).selectOption(action.project);
      await page.waitForURL(url => url.searchParams.get("project") === action.project);
      model.project = action.project; return;
  }
}

/** Properties that must hold after every action. */
async function check(page: Page, model: Model, errors: string[], uploads: () => number) {
  assert.deepEqual(errors, [], "property no-page-errors");
  assert.equal(uploads(), 0, "property no-provider-uploads");
  const observed = await stats(page);
  const live = observed.created.filter(url => !observed.revoked.includes(url)).length;
  assert.equal(live, model.files.length, `property preview-release: ${live} live preview URLs for ${model.files.length} files`);
  if (!model.open) return;
  const order = await page.locator('[data-slot="sortable-item"] img').evaluateAll(images => images.map(image => image.getAttribute("alt")));
  assert.deepEqual(order, model.files, "property file-order");
  await page.getByRole("dialog", { name: copy(language, "newTicket"), exact: true }).getByText(CAPTURED, { exact: true })
    .waitFor({ timeout: 2000 }).catch(() => { throw new Error(`property captured-project: draft no longer shows ${CAPTURED} while ${model.project} is selected`); });
}

function save(name: string, sequence: Sequence) {
  const file = path.join(EVIDENCE_DIR, "public", "explore", `${name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(sequence, null, 2) + "\n");
  return file;
}

async function explore(browser: Awaited<ReturnType<typeof launch>>, seed: number | null, replay: Action[] | null) {
  const name = seed === null ? "replay" : `seed-${seed}`;
  const sequence: Sequence = { version: 1, commit: readManifest().commit, seed, probe, config, fixture: FIXTURE, actions: [] };
  const started = Date.now();
  try {
    await capture("explore", name, async () => {
      const session = await open(browser, "customer", language);
      if (probe === "leak") await session.page.evaluate(() => { URL.revokeObjectURL = () => undefined; });
      const model: Model = { files: [], pins: {}, open: true, project: "POS", added: 0, titled: false };
      const random = mulberry32(seed ?? 0);
      const total = replay?.length ?? config.actions;
      for (let step = 0; step < total && (replay || Date.now() - started < config.budgetMs); step++) {
        const action = replay ? replay[step] : choose(model, random);
        sequence.actions.push(action);
        try {
          await apply(session.page, model, action);
          await check(session.page, model, session.errors, session.uploads);
        } catch (error) {
          sequence.failure = { step, message: (error instanceof Error ? error.message : String(error)).split("\n")[0] };
          throw error;
        }
      }
      // End state: discarding the draft releases every preview.
      if (!model.open) await apply(session.page, model, { kind: "resume" });
      await session.page.getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      await session.page.getByRole("alertdialog").getByRole("button", { name: copy(language, "discardDraft"), exact: true }).click();
      const observed = await stats(session.page);
      assert.deepEqual([...observed.revoked].sort(), [...observed.created].sort(), "property discard-releases-all");
    });
    console.log(`explore ${name}: ${sequence.actions.length} actions held every property (${Date.now() - started} ms)`);
    return true;
  } catch (error) {
    console.error(`explore ${name}: FAILED at step ${sequence.failure?.step ?? "end"}: ${sequence.failure?.message ?? String(error).split("\n")[0]}`);
    console.error(`  sequence: ${save(name, sequence)}`);
    console.error(`  replay:   EXPLORE_REPLAY=${path.join(EVIDENCE_DIR, "public", "explore", `${name}.json`)}${probe ? ` EXPLORE_PROBE=${probe}` : ""} pnpm test:explore`);
    return false;
  }
}

const browser = await launch();
try {
  let passed = true;
  if (env.EXPLORE_REPLAY) {
    const recorded = JSON.parse(readFileSync(env.EXPLORE_REPLAY, "utf8")) as Sequence;
    console.log(`Replaying ${recorded.actions.length} actions (recorded failure: ${recorded.failure ? `step ${recorded.failure.step}: ${recorded.failure.message}` : "none"})`);
    passed = await explore(browser, null, recorded.actions);
  } else {
    for (const seed of (env.EXPLORE_SEEDS ?? "1,2,3").split(",").map(Number)) passed = await explore(browser, seed, null) && passed;
  }
  process.exitCode = passed ? 0 : 1;
} finally { await browser.close(); }
