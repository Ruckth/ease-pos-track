import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internalJobQuery } from "../../convex/functions";
import { makeFunctionReference } from "convex/server";
import schema from "../../convex/schema";
import { modules } from "./modules";

test("guarded registrations log original unknown errors and return only INTERNAL_ERROR", async () => {
  const original = new Error("Unexpected adapter failure");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fail = internalJobQuery({ args: {}, handler: () => { throw original; } });
  const t = convexTest(schema, { ...modules, "../../convex/error_fixture.ts": async () => ({ fail }) });
  try {
    await expect(t.query(makeFunctionReference<"query">("error_fixture:fail"), {}))
      .rejects.toMatchObject({ data: { code: "INTERNAL_ERROR" } });
    expect(log).toHaveBeenCalledExactlyOnceWith(original);
  } finally { log.mockRestore(); }
});
