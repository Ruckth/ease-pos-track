import { afterEach, beforeEach, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { fixtures, identityTest } from "./identity-harness";
import { modules } from "./modules";

export const NOW = Date.UTC(2026, 10, 19, 23, 59);
type Named = "owner" | "primary" | "backup";
/** Admitted named sessions (transport only) and durable staff IDs, filled per fixture. */
export const TOKEN = { owner: "", primary: "", backup: "", customer: "", pending: "" };
export const STAFF: Record<Named, string> = { owner: "", primary: "", backup: "" };
export const config = {
  get areas() {
    return [
      { code: "hardware", en: "Hardware", th: "ฮาร์ดแวร์", meaning: "Physical equipment", primary: [STAFF.primary], fallback: [STAFF.backup], active: true },
      { code: "ops", en: "Operations", th: "งานปฏิบัติการ", meaning: "Operational workflows", primary: [STAFF.owner], fallback: [STAFF.backup], active: true },
    ];
  },
  products: [{ code: "printer", en: "Printer", th: "เครื่องพิมพ์", meaning: "Receipt printer" }],
  symptoms: [
    { code: "blank", en: "Blank receipt", th: "ใบเสร็จว่าง", meaning: "Receipt has no printing" },
    { code: "other", en: "Other", th: "อื่นๆ", meaning: "Other symptom" },
  ],
  rules: [{ product: "printer", symptom: "blank", area: "hardware" }],
  get intake() { return [STAFF.primary]; },
  get backup() { return STAFF.backup; },
};

export function setupRoutingTestClock() {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3210");
    vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true");
    vi.stubEnv("MEDIA_CLEANUP_ENABLED", "false");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
}

export async function routingFixture() {
  const t = identityTest(modules);
  for (const name of ["owner", "primary", "backup"] as const) {
    const staff = await t.mutation(fixtures.staff, { email: `${name}@fixture.test`, name, role: name === "owner" ? "owner" : "staff" });
    TOKEN[name] = staff.session;
    STAFF[name] = staff.staffId;
  }
  // A signed-in Google identity that never became staff.
  TOKEN.pending = (await t.mutation(fixtures.pending, { email: "pending@fixture.test", subject: "fixture-pending" })).session;
  const projectId = await t.run(({ db }) => db.insert("projects", { key: "POS", name: "POS", createdAt: NOW, updatedAt: NOW }));
  const customer = await t.mutation(fixtures.customer, { username: "fixturecustomer", projectIds: [projectId] });
  TOKEN.customer = customer.session;
  const customerId = customer.customerId;
  const settings = () => t.query(api.ticket_routing.getSettings, { token: TOKEN.owner, projectId });
  const save = async (overrides: Partial<typeof config> = {}, token = TOKEN.owner) => t.mutation(api.ticket_routing.saveConfiguration, {
    token, projectId, expectedGeneration: (await settings())!.policy.policyGeneration, ...config, ...overrides,
  });
  let sequence = 0;
  const create = async (title = "Fixture Ticket", token = TOKEN.owner, routingClassification?: { product?: string; symptom?: string; restricted: boolean }) => {
    const requestId = `test-routing-intent-${++sequence}`;
    const { intentId, secret } = await t.mutation(api.uploads.createUploadIntent, { token, idempotencyKey: requestId, files: [] });
    return await t.mutation(api.tickets.createTicket, { token, requestId, title, description: "synthetic-canary.txt", projectId,
      media: [], uploadIntentId: intentId, uploadIntentSecret: secret, routingClassification });
  };
  const snapshot = () => t.run(async ({ db }) => ({
    tickets: await db.query("tickets").collect(),
    events: await db.query("ticketAssignmentEvents").collect(),
    suggestions: await db.query("ticketRoutingSuggestions").collect(),
    requests: await db.query("ticketRoutingSuggestionRequests").collect(),
  }));
  await save();
  return { t, projectId, customerId, settings, save, create, snapshot };
}
