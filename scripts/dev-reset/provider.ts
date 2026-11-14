import { UTApi } from "uploadthing/server";
import { providerStorage } from "../../shared/storage";
import type { ResetProvider } from "./core";

/** Local execution never constructs a network client. Arbitrary keys remain unresolved. */
export function fakeResetProvider(): ResetProvider {
  return { kind: "fake", appId: async () => "local-fake", ownedKeys: async keys => new Set(keys.filter(key => key.startsWith("local-fake-"))),
    delete: async () => ({ outcome: "deleted" }) };
}

type ProviderClient = Pick<UTApi, "listFiles" | "deleteFiles">;
export function uploadthingResetProvider(token: string | undefined, expectedAppId: string, dependencies: {
  fetch?: typeof fetch; client?: (token: string) => ProviderClient;
} = {}): ResetProvider {
  // UTApi's app scope comes from this token's appId (installed SDK v7).
  // Check it before constructing the client or authenticating a read.
  let id: string; let apiKey: string;
  try { ({ appId: id, apiKey } = JSON.parse(Buffer.from(token ?? "", "base64").toString("utf8"))); }
  catch { throw new Error("RESET_PROVIDER_TOKEN_INVALID"); }
  if (!id || id !== expectedAppId) throw new Error("RESET_PROVIDER_APP_MISMATCH");
  if (!apiKey || typeof apiKey !== "string") throw new Error("RESET_PROVIDER_TOKEN_INVALID");
  const api = (dependencies.client ?? (token => new UTApi({ token, apiUrl: "https://api.uploadthing.com", logLevel: "None" })))(token!);
  const storage = providerStorage(api);
  let owned: Set<string> | undefined;
  let verified = false;
  return {
    kind: "uploadthing",
    async appId() {
      // The token is editable JSON. Check the app controlled by its API key,
      // not just its claimed appId. UTApi v7 does not expose getAppInfo.
      // https://docs.uploadthing.com/api-reference/openapi-spec
      try {
        const response = await (dependencies.fetch ?? fetch)("https://api.uploadthing.com/v7/getAppInfo", {
          method: "POST", headers: { "x-uploadthing-api-key": apiKey }, redirect: "error", signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok || (await response.json()).appId !== expectedAppId) throw new Error("mismatch");
        verified = true;
        return expectedAppId;
      } catch { throw new Error("RESET_PROVIDER_APP_UNVERIFIED"); }
    },
    async ownedKeys() {
      if (!verified) throw new Error("RESET_PROVIDER_APP_UNVERIFIED");
      {
        const listed = new Set<string>();
        const seen = new Set<string>();
        let offset = 0;
        while (true) {
          const page = await api.listFiles({ limit: 500, offset });
          if (!Array.isArray(page.files) || typeof page.hasMore !== "boolean") throw new Error("RESET_PROVIDER_INCOMPLETE_INVENTORY");
          for (const file of page.files) {
            if (typeof file.key !== "string" || !file.key || seen.has(file.key)) throw new Error("RESET_PROVIDER_INCOMPLETE_INVENTORY");
            seen.add(file.key);
            if (file.status === "Uploaded") listed.add(file.key);
          }
          if (!page.hasMore) break;
          if (!page.files.length) throw new Error("RESET_PROVIDER_INCOMPLETE_INVENTORY");
          offset += page.files.length;
        }
        owned = listed;
      }
      return owned;
    },
    delete: async key => {
      if (!verified || !owned?.has(key)) throw new Error("RESET_PROVIDER_OWNERSHIP_UNVERIFIED");
      return storage.deleteFiles([key]);
    },
  };
}
