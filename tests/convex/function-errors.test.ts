import { convexTest } from "convex-test";
import { expect, test, vi } from "vitest";
import { internalJobQuery } from "../../convex/functions";
import { makeFunctionReference } from "convex/server";
import schema from "../../convex/schema";
import { modules } from "./modules";

test("guarded registrations sanitize unknown errors in both logs and responses", async () => {
  const original = new Error("Unexpected adapter failure");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fail = internalJobQuery({ name: "error_fixture:fail", args: {}, handler: () => { throw original; } });
  const t = convexTest(schema, { ...modules, "../../convex/error_fixture.ts": async () => ({ fail }) });
  try {
    await expect(t.query(makeFunctionReference<"query">("error_fixture:fail"), {}))
      .rejects.toMatchObject({ data: { code: "INTERNAL_ERROR" } });
    expect(log).toHaveBeenCalledExactlyOnceWith({ code: "INTERNAL_ERROR", functionName: "error_fixture:fail", errorClass: "Error" });
  } finally { log.mockRestore(); }
});
