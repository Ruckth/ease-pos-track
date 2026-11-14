import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internalJobQuery } from "../../convex/functions";
import { makeFunctionReference } from "convex/server";
import schema from "../../convex/schema";
import { modules } from "./modules";

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["https://example.convex.cloud", "true", false],
  ["http://127.0.0.1.evil.test:3212", "true", false],
  ["invalid", "true", false],
  ["", "true", false],
  ["http://127.0.0.1:3212", "false", false],
  ["http://127.0.0.1:3212", "true", true],
  ["http://localhost:3212", "true", true],
  ["http://[::1]:3212", "true", true],
])("guarded errors disclose the message only in opted-in loopback logs (%s, %s)", async (url, enabled, local) => {
  vi.stubEnv("CONVEX_CLOUD_URL", url);
  vi.stubEnv("LOCAL_FIXTURES_ENABLED", enabled);
  const original = new Error("Unexpected adapter failure");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fail = internalJobQuery({ name: "error_fixture:fail", args: {}, handler: () => { throw original; } });
  const t = convexTest(schema, { ...modules, "../../convex/error_fixture.ts": async () => ({ fail }) });
  try {
    await expect(t.query(makeFunctionReference<"query">("error_fixture:fail"), {}))
      .rejects.toMatchObject({ data: { code: "INTERNAL_ERROR" } });
    expect(log).toHaveBeenCalledExactlyOnceWith({ code: "INTERNAL_ERROR", functionName: "error_fixture:fail", errorClass: "Error", ...(local ? { message: original.message } : {}) });
  } finally { log.mockRestore(); }
});
