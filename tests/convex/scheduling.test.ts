import { convexTest } from "convex-test";
import { makeFunctionReference } from "convex/server";
import { afterEach, expect, test, vi } from "vitest";
import schema from "../../convex/schema";
import { modules } from "./modules";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("completion helpers wait for a held provider action and its scheduled checkpoint", async () => {
  vi.useFakeTimers();
  let releaseProvider!: (response: Response) => void;
  let markStarted!: () => void;
  const providerResponse = new Promise<Response>((resolve) => { releaseProvider = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const provider = vi.fn(() => { markStarted(); return providerResponse; });
  vi.stubGlobal("fetch", provider);

  const fixtures = import.meta.glob("./fixtures/scheduler.ts");
  const t = convexTest(schema, {
    ...modules,
    "../../convex/fixture.ts": fixtures["./fixtures/scheduler.ts"],
  });
  const id = await t.mutation(makeFunctionReference<"mutation">("fixture:schedule"), {});
  vi.runAllTimers();
  await started;

  const scheduled = () => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  expect((await scheduled()).filter((job) => job.state.kind === "pending")).toHaveLength(0);
  expect(await t.run((ctx) => ctx.db.system.get(id)))
    .toMatchObject({ state: { kind: "inProgress" } });

  let inProgressFinished = false;
  let allFinished = false;
  const inProgress = t.finishInProgressScheduledFunctions().then(() => { inProgressFinished = true; });
  const all = t.finishAllScheduledFunctions(vi.runAllTimers).then(() => { allFinished = true; });
  try {
    // Zero pending jobs above while the action is inProgress proves an empty queue
    // is not completion. This round trip observes helpers with the provider still held.
    expect(await t.run((ctx) => ctx.db.query("projects").collect())).toEqual([]);
    expect(inProgressFinished).toBe(false);
    expect(allFinished).toBe(false);
  } finally {
    releaseProvider(new Response(null, { status: 204 }));
    await Promise.all([inProgress, all]);
  }

  expect(provider).toHaveBeenCalledOnce();
  expect(await t.run((ctx) => ctx.db.query("projects").collect()))
    .toMatchObject([{ key: "DONE" }]);
  expect(await scheduled()).toHaveLength(2);
  expect((await scheduled()).every((job) => job.state.kind === "success")).toBe(true);
});
