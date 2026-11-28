import { identityTest } from "./identity-harness";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { ticketOperations, type TicketAdapter } from "../../src/features/tickets/operations";
import { modules } from "./modules";

beforeEach(() => { vi.stubEnv("LOCAL_FIXTURES_ENABLED", "true"); vi.stubEnv("CONVEX_CLOUD_URL", "http://127.0.0.1:3212"); });
afterEach(() => vi.unstubAllEnvs());

test("both browser roles share edit, annotation and undo intent through registered handlers; conflicts never retry", async () => {
  const t = identityTest(modules);
  const seed = await t.mutation(internal.seed.install, {});
  const adapterFor = (token: string): TicketAdapter => ({
    edit: args => t.mutation(api.tickets.editTicket, { ...args, token }), undoEdit: args => t.mutation(api.tickets.undoTicketEdit, { ...args, token }),
    status: args => t.mutation(api.tickets.updateTicketStatus, { ...args, token }), undoStatus: args => t.mutation(api.tickets.undoTicketStatus, { ...args, token }),
    urgency: args => t.mutation(api.tickets.updateUrgencyScore, { ...args, token }), undoUrgency: args => t.mutation(api.tickets.undoUrgencyScore, { ...args, token }),
    archive: args => t.mutation(api.tickets.archiveTicket, { ...args, token }), restore: args => t.mutation(api.tickets.restoreTicket, { ...args, token }),
    addAnnotation: args => t.mutation(api.annotations.addAnnotation, { ...args, token }), updateAnnotation: args => t.mutation(api.annotations.updateAnnotation, { ...args, token }),
    undoAnnotation: args => t.mutation(api.annotations.undoAnnotationUpdate, { ...args, token }), removeAnnotation: args => t.mutation(api.annotations.removeAnnotation, { ...args, token }),
    restoreAnnotation: args => t.mutation(api.annotations.restoreAnnotation, { ...args, token }),
  });
  const id = seed.tickets[1];
  await t.run(ctx => ctx.db.patch(id, { media: [{ key: "fake", url: "https://fixture.invalid/image", name: "fixture.png", size: 1, type: "image/png" }] }));
  for (const token of [seed.sessions[0], seed.sessions[1]]) {
    let undo: (() => Promise<unknown>) | undefined;
    const operations = ticketOperations(adapterFor(token), { success: (_message, _reference, callback) => { undo = callback; } });
    const read = async () => (await t.query(api.tickets.getTicket, { token, id }))!;
    const item = await read();
    await operations.edit(item, "Edited", "New description");
    expect((await read()).title).toBe("Edited");
    await undo!();
    expect((await read()).title).toBe(item.title);
    await expect(operations.edit(item, "Stale", "")).rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" }, disposition: "conflict" });
    expect((await read()).title).toBe(item.title);
    const annotation = await operations.addAnnotation(await read(), { mediaIndex: 0, kind: "point", x: 0.2, y: 0.4, text: "Pin" });
    await operations.updateAnnotation(await read(), { annotationId: annotation.annotationId, text: "Changed pin" });
    await undo!();
    expect((await read()).annotations[0].text).toBe("Pin");
    await operations.removeAnnotation(await read(), annotation.annotationId);
    await undo!();
    expect((await read()).annotations.find(pin => pin.id === annotation.annotationId)?.deletedAt).toBeUndefined();
  }
  const staff = ticketOperations(adapterFor(seed.sessions[0]), { success: () => {} });
  const readStaff = async () => (await t.query(api.tickets.getTicket, { token: seed.sessions[0], id }))!;
  await staff.status(await readStaff(), "acknowledged");
  await staff.urgency(await readStaff(), 75);
  let staleUndo: (() => Promise<unknown>) | undefined;
  const editing = ticketOperations(adapterFor(seed.sessions[0]), { success: (_message, _reference, callback) => { staleUndo = callback; } });
  await editing.edit(await readStaff(), "Edit before intervening write", "");
  await staff.edit(await readStaff(), "Intervening write", "");
  await expect(staleUndo!()).rejects.toMatchObject({ data: { code: "VERSION_CONFLICT" }, disposition: "conflict" });
  expect((await readStaff()).title).toBe("Intervening write");
  const otherId = seed.tickets[0];
  const first = await readStaff();
  const second = (await t.query(api.tickets.getTicket, { token: seed.sessions[0], id: otherId }))!;
  const notices = new Map<string, () => Promise<unknown>>();
  const editingBoth = ticketOperations(adapterFor(seed.sessions[0]), {
    success: (_message, reference, undo) => { if (undo) notices.set(reference, undo); },
  });
  await editingBoth.edit(first, "First independent edit", first.description);
  await editingBoth.edit(second, "Second independent edit", second.description);
  expect([...notices.keys()]).toEqual(["POS-0002", "POS-0001"]);
  await notices.get("POS-0001")!();
  expect((await t.query(api.tickets.getTicket, { token: seed.sessions[0], id: otherId }))?.title).toBe(second.title);
  expect((await readStaff()).title).toBe("First independent edit");
  await notices.get("POS-0002")!();
  expect((await readStaff()).title).toBe(first.title);
  const customer = ticketOperations(adapterFor(seed.sessions[1]), { success: () => {} });
  await expect(customer.status(await readStaff(), "done")).rejects.toMatchObject({ data: { code: "STAFF_ONLY" }, disposition: "rejected" });
  await customer.archive(await readStaff(), true);
  await staff.restore(await readStaff());
  expect(await readStaff()).toMatchObject({ status: "acknowledged", urgencyScore: 75, lifecycle: "active" });
  const foreign = ticketOperations(adapterFor(seed.sessions[2]), { success: () => {} });
  await expect(foreign.edit(await readStaff(), "Foreign", "")).rejects.toMatchObject({ data: { code: "TICKET_UNAVAILABLE" }, disposition: "rejected" });
});
