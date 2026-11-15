import { makeFunctionReference } from "convex/server";
import { internalAction, internalMutation } from "../../../convex/_generated/server";

// Only scheduling.test.ts registers this module; it is never deployed.
const providerAction = makeFunctionReference<"action">("fixture:requestProvider");
const checkpointReference = makeFunctionReference<"mutation">("fixture:checkpoint");

export const schedule = internalMutation({
  args: {},
  handler: (ctx) => ctx.scheduler.runAfter(100, providerAction, {}),
});

export const requestProvider = internalAction({
  args: {},
  handler: async (ctx) => {
    const response = await fetch("https://provider.example.test/delete", { method: "POST" });
    if (!response.ok) throw new Error("FAKE_PROVIDER_FAILED");
    await ctx.scheduler.runAfter(100, checkpointReference, {});
  },
});

export const checkpoint = internalMutation({
  args: {},
  handler: (ctx) => ctx.db.insert("projects", {
    name: "Provider completed", key: "DONE", createdAt: Date.now(), updatedAt: Date.now(),
  }),
});

