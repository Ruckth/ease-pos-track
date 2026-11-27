import assert from "node:assert/strict";
import type { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { api } from "../../convex/_generated/api";

type Client = Pick<ConvexHttpClient, "query" | "mutation" | "action">;
export const seedCustomers = ["alice", "bob"];

export type SeedClients = {
  /** Carries the named Owner's live session (bootstrapped and signed in beforehand). */
  owner: Client;
  /** No credentials: invitation signup and password sign-in. */
  anonymous: Client;
  /** A client carrying the given access token. */
  signedIn: (accessToken: string) => Client;
};

/**
 * Fresh installation only. The Owner creates Projects and Project invitations;
 * customers enroll through invitation-bound signup. All writes use registered
 * commands, including totals and audit.
 */
export async function seedDevelopment(clients: SeedClients, credentials: { customer: string }) {
  const { owner, anonymous } = clients;
  assert.equal((await owner.query(api.identity.viewer, {}))?.kind, "staff", "seed requires a signed-in Owner");
  assert.equal((await owner.query(api.projects.listProjects, {})).length, 0, "seed requires empty Projects");
  const projects = [];
  for (const [key, name] of [["POS", "Point of Sale"], ["APP", "Customer App"]]) {
    projects.push(await owner.mutation(api.projects.createProject, { key, name }));
  }
  const customers: { client: Client; refreshToken: string }[] = [];
  for (const username of seedCustomers) {
    const first: { secret: string } = await owner.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, projectId: projects[0]._id });
    const enrolled: FunctionReturnType<typeof api.auth.signUpWithInvitation> = await anonymous.mutation(api.auth.signUpWithInvitation, {
      invitation: first.secret, username, displayName: username[0].toUpperCase() + username.slice(1), password: credentials.customer,
    });
    assert.equal(enrolled.status, "complete", "customer enrollment failed");
    if (enrolled.status !== "complete") throw new Error("SEED_ENROLLMENT_FAILED");
    const client = clients.signedIn(enrolled.tokens.accessToken);
    const recovery = await client.mutation(api.identity.createRecoveryCode, {});
    if (!recovery.ok) throw new Error("SEED_RECOVERY_ENROLLMENT_FAILED");
    const confirmed = await client.mutation(api.identity.confirmRecoveryEnrollment, { code: recovery.code });
    if (!confirmed.ok) throw new Error("SEED_RECOVERY_ENROLLMENT_FAILED");
    for (const project of projects.slice(1)) {
      const invitation: { secret: string } = await owner.mutation(api.identity.createCustomerInvitation, { eligibilityConfirmed: true, projectId: project._id });
      assert.equal((await client.mutation(api.identity.joinWithInvitation, { invitation: invitation.secret })).status, "joined");
    }
    customers.push({ client, refreshToken: enrolled.tokens.refreshToken });
  }
  const actors = [owner, ...customers.map(customer => customer.client)];
  for (const project of projects) {
    for (const [index, client] of Array.from(actors.entries())) {
      const result = await client.mutation(api.tickets.createTextTicket, {
        projectKey: project.key, requestId: `dev-seed-${project.key}-${index}`,
        title: ["Printer calibration", "Receipt alignment", "Payment confirmation"][index],
        description: "Disposable development example",
      });
      assert.equal(result.ticket.ticketNumber, index + 1);
      if (index) await owner.mutation(api.tickets.updateTicketStatus, {
        id: result.ticket._id, expectedVersion: 0, status: index === 1 ? "acknowledged" : "in_progress",
      });
    }
  }
  const alice = actors[1];
  // Verification returns the example dataset to the deterministic starting state.
  for (const project of projects) {
    const page = await owner.query(api.tickets.pageTickets, { projectId: project._id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
    assert.deepEqual(page.page.map(ticket => ticket.ticketNumber), [3, 2, 1]);
    const totals = await owner.query(api.tickets.laneTotals, { projectId: project._id });
    assert.equal(totals.new, 1); assert.equal(totals.acknowledged, 1); assert.equal(totals.in_progress, 1);
    const own = await alice.query(api.tickets.pageTickets, { projectId: project._id, lifecycle: "active", paginationOpts: { numItems: 50, cursor: null } });
    assert.deepEqual(own.page.map(ticket => ticket.ticketNumber), [2]);
    assert.equal(await alice.query(api.tickets.getTicket, { id: page.page[0]._id }), null);
    const search = await owner.query(api.tickets.searchTickets, { projectId: project._id, lifecycle: "active", search: `${project.key}-0001` });
    assert.equal(search.matches[0]?._id, page.page[2]._id);
    const id = own.page[0]._id;
    const edit = await alice.mutation(api.tickets.editTicket, { id, title: "Receipt alignment updated", description: "Disposable development example", expectedVersion: 1 });
    assert.ok(edit.eventId);
    const undo = await alice.mutation(api.tickets.undoTicketEdit, { eventId: edit.eventId, expectedVersion: edit.version });
    const archived = await alice.mutation(api.tickets.archiveTicket, { id, expectedVersion: undo.version });
    await owner.mutation(api.tickets.restoreTicket, { id, expectedVersion: archived.version });
    assert.deepEqual(await owner.query(api.tickets.laneTotals, { projectId: project._id }), totals);
  }
  for (const customer of customers) {
    assert.equal((await customer.client.query(api.identity.viewer, {}))?.kind, "customer");
    await anonymous.mutation(api.auth.signOut, { refreshToken: customer.refreshToken });
  }
  // Prove the stored credential works, rather than only the enrollment session.
  const signIn = await anonymous.action(api.auth.signInWithPassword, { username: seedCustomers[0], password: credentials.customer });
  assert.equal(signIn.status, "complete");
  if (signIn.status === "complete") await anonymous.mutation(api.auth.signOut, { refreshToken: signIn.tokens.refreshToken });
  return { ok: true, checks: ["named Owner session", "invitation enrollment and password sign-in", "Projects and memberships", "six numbered Tickets", "workflow totals", "owner isolation", "reference search", "customer edit/undo", "archive/restore", "session revocation"] };
}
