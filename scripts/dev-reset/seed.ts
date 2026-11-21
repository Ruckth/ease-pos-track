import assert from "node:assert/strict";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";

type Client = Pick<ConvexHttpClient, "query" | "mutation" | "action">;
export const seedCustomers = ["alice@dev.example", "bob@dev.example"];

/** Fresh installation only. All writes use registered domain commands, including totals and audit. */
export async function seedDevelopment(client: Client, credentials: { staff: string; customer: string }) {
  const { token: staff } = await client.action(api.auth.login, { password: credentials.staff, clientId: "dev-reset-staff-client" });
  assert.equal((await client.query(api.projects.listProjects, { token: staff })).length, 0, "seed requires empty Projects");
  const projects = [];
  for (const [key, name] of [["POS", "Point of Sale"], ["APP", "Customer App"]]) {
    projects.push(await client.mutation(api.projects.createProject, { token: staff, key, name }));
  }
  const tokens = [staff];
  for (const [index, email] of Array.from(seedCustomers.entries())) {
    tokens.push((await client.action(api.customers.register, { email, password: credentials.customer, clientId: `dev-reset-customer-${index}` })).token);
    for (const project of projects) await client.mutation(api.projects.addProjectMember, { token: staff, projectId: project._id, email });
  }
  for (const project of projects) {
    for (const [index, token] of Array.from(tokens.entries())) {
      const result = await client.mutation(api.tickets.createTextTicket, {
        token, projectKey: project.key, requestId: `dev-seed-${project.key}-${index}`,
        title: ["Printer calibration", "Receipt alignment", "Payment confirmation"][index],
        description: "Disposable development example",
      });
      assert.equal(result.ticket.ticketNumber, index + 1);
      if (index) await client.mutation(api.tickets.updateTicketStatus, {
        token: staff, id: result.ticket._id, expectedVersion: 0, status: index === 1 ? "acknowledged" : "in_progress",
      });
    }
  }
  // Verification returns the example dataset to the deterministic starting state.
  for (const project of projects) {
    const page = await client.query(api.tickets.pageTickets, { token: staff, projectId: project._id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
    assert.deepEqual(page.page.map(ticket => ticket.ticketNumber), [3, 2, 1]);
    const totals = await client.query(api.tickets.laneTotals, { token: staff, projectId: project._id });
    assert.equal(totals.new, 1); assert.equal(totals.acknowledged, 1); assert.equal(totals.in_progress, 1);
    const own = await client.query(api.tickets.pageTickets, { token: tokens[1], projectId: project._id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
    assert.deepEqual(own.page.map(ticket => ticket.ticketNumber), [2]);
    assert.equal(await client.query(api.tickets.getTicket, { token: tokens[1], id: page.page[0]._id }), null);
    const search = await client.query(api.tickets.searchTickets, { token: staff, projectId: project._id, lifecycle: "active", search: `${project.key}-0001` });
    assert.equal(search.matches[0]?._id, page.page[2]._id);
    const id = own.page[0]._id;
    const edit = await client.mutation(api.tickets.editTicket, { token: tokens[1], id, title: "Receipt alignment updated", description: "Disposable development example", expectedVersion: 1 });
    assert.ok(edit.eventId);
    const undo = await client.mutation(api.tickets.undoTicketEdit, { token: tokens[1], eventId: edit.eventId, expectedVersion: edit.version });
    const archived = await client.mutation(api.tickets.archiveTicket, { token: tokens[1], id, expectedVersion: undo.version });
    await client.mutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: archived.version });
    assert.deepEqual(await client.query(api.tickets.laneTotals, { token: staff, projectId: project._id }), totals);
  }
  for (const [index, token] of Array.from(tokens.entries())) {
    assert.equal((await client.query(api.auth.currentSession, { token }))?.role, index ? "customer" : "staff");
    await client.mutation(api.auth.logout, { token });
  }
  // Prove stored customer hashes work, rather than only registration sessions.
  const customer = await client.action(api.customers.login, { email: seedCustomers[0], password: credentials.customer, clientId: "dev-reset-customer-login" });
  await client.mutation(api.auth.logout, { token: customer.token });
  return { ok: true, checks: ["staff/customer sign-in", "Projects and memberships", "six numbered Tickets", "workflow totals", "owner isolation", "reference search", "customer edit/undo", "archive/restore", "session revocation"] };
}
