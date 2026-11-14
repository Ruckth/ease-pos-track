import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { internalJobAction, internalJobMutation } from "./functions";
import { requireLocalFixtures } from "./seed";
import { requireActor } from "./session_auth";
import { requireUsableProject } from "./domain/projects";
import { createTicketRecord } from "./domain/tickets";
import { actorFields, newTicketOwnership } from "./authz";
import { errorCode } from "../shared/errors";

/** Fake metadata is confined to the opt-in local fixture. No provider I/O. */
export const annotationFixture = internalJobMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    requireLocalFixtures();
    const { actor, session } = await requireActor(ctx, token);
    const project = await ctx.db.query("projects").withIndex("by_key", q => q.eq("key", "POS")).unique();
    if (!project) throw new Error("PROJECT_NOT_FOUND");
    return (await createTicketRecord(ctx, {
      project: await requireUsableProject(ctx, actor, project._id),
      title: "Local annotation fixture", description: "Fake metadata only",
      media: [{ key: `local-fake-${crypto.randomUUID()}`, name: "fixture.png", size: 1, type: "image/png", url: "https://fixture.invalid/image.png" }],
      ownership: newTicketOwnership(actor), author: { sessionId: session._id, ...actorFields(actor) }, now: Date.now(),
    }))._id;
  },
});

export const run = internalJobAction({
  args: {},
  handler: async (ctx): Promise<{ ok: true; checks: string[] }> => {
    requireLocalFixtures();
    const checks: string[] = [];
    function check(value: unknown, name: string) {
      if (!value) throw new Error(`Local smoke failed: ${name}`);
      checks.push(name);
    }
    async function denied(run: () => Promise<unknown>, code: string, name: string) {
      try { await run(); }
      catch (error) { check(errorCode(error) === code, name); return; }
      throw new Error(`Local smoke failed: ${name}`);
    }
    const seeded = await ctx.runAction(internal.seed.run, {});
    for (let index = 0; index < seeded.sessions.length; index++) {
      const token = seeded.sessions[index];
      check((await ctx.runQuery(api.auth.currentSession, { token }))?.role === (index === 0 ? "staff" : "customer"), "random seed session and explicit role");
    }
    const staff = (await ctx.runMutation(api.auth.login, { password: "LocalStaff123!", clientId: "local-smoke-staff-client" })).token;
    const alice = (await ctx.runAction(api.customers.login, { email: "alice@local.test", password: "LocalCustomer123!", clientId: "local-smoke-alice-client" })).token;
    const bob = (await ctx.runAction(api.customers.login, { email: "bob@local.test", password: "LocalCustomer123!", clientId: "local-smoke-bob-client" })).token;
    check((await ctx.runQuery(api.auth.currentSession, { token: staff }))?.role === "staff", "staff credential and explicit role");
    check((await ctx.runQuery(api.auth.currentSession, { token: alice }))?.role === "customer", "customer credential and explicit role");
    await denied(() => ctx.runMutation(api.tickets.createTextTicket, { token: alice, projectKey: "APP", requestId: crypto.randomUUID(), title: "Denied", description: "" }), "PROJECT_NOT_FOUND", "customer foreign Project denied");
    for (const token of [staff, alice]) {
      const created = await ctx.runMutation(api.tickets.createTextTicket, { token, projectKey: "POS", requestId: crypto.randomUUID(), title: "Local text-only smoke", description: "" });
      const id = created.ticket._id;
      check(created.created && created.ticket.lifecycle === "active" && created.ticket.media.length === 0, `${token === staff ? "staff" : "customer"} text-only create`);
      check(Boolean(await ctx.runQuery(api.tickets.getTicket, { token, id })), "detail");
      if (token === alice) {
        check(await ctx.runQuery(api.tickets.getTicket, { token: bob, id }) === null, "foreign customer detail denied");
        await denied(() => ctx.runMutation(api.tickets.editTicket, { token: bob, id, title: "Denied", description: "", expectedVersion: 0 }), "TICKET_UNAVAILABLE", "foreign customer edit denied");
        await denied(() => ctx.runMutation(api.tickets.updateTicketStatus, { token, id, status: "done", expectedVersion: 0 }), "STAFF_ONLY", "customer status denied");
        await denied(() => ctx.runMutation(api.tickets.updateUrgencyScore, { token, id, urgencyScore: 50, expectedVersion: 0 }), "STAFF_ONLY", "customer urgency denied");
      }
      await ctx.runMutation(api.tickets.editTicket, { token, id, title: "Edited local smoke", description: "", expectedVersion: 0 });
      await ctx.runMutation(api.tickets.updateTicketStatus, { token: staff, id, status: "acknowledged", expectedVersion: 1 });
      await ctx.runMutation(api.tickets.updateUrgencyScore, { token: staff, id, urgencyScore: 42, expectedVersion: 2 });
      await ctx.runMutation(api.tickets.archiveTicket, { token, id, expectedVersion: 3 });
      if (token === alice) await denied(() => ctx.runMutation(api.tickets.restoreTicket, { token, id, expectedVersion: 4 }), "STAFF_ONLY", "customer restore denied");
      await ctx.runMutation(api.tickets.restoreTicket, { token: staff, id, expectedVersion: 4 });
      const detail = await ctx.runQuery(api.tickets.getTicket, { token, id });
      check(detail?.version === 5 && detail.lifecycle === "active" && detail.archivedAt === undefined && detail.status === "acknowledged" && detail.urgencyScore === 42, "edit/status/urgency/archive/restore");
    }
    const id = await ctx.runMutation(internal.local_smoke.annotationFixture, { token: alice });
    await denied(() => ctx.runMutation(api.annotations.addAnnotation, { token: bob, id, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Denied" }), "TICKET_UNAVAILABLE", "foreign customer annotation denied");
    const annotationId = await ctx.runMutation(api.annotations.addAnnotation, { token: alice, id, kind: "point", mediaIndex: 0, x: 0.5, y: 0.5, text: "Local note" });
    await ctx.runMutation(api.annotations.updateAnnotation, { token: staff, id, annotationId, text: "Reviewed local note" });
    await ctx.runMutation(api.annotations.removeAnnotation, { token: alice, id, annotationId });
    await ctx.runMutation(api.annotations.restoreAnnotation, { token: staff, id, annotationId });
    check((await ctx.runQuery(api.annotations.listAnnotationActivity, { token: alice, id })).length === 4, "annotation create/edit/remove/restore with fake metadata");
    for (const token of [staff, alice, bob, ...seeded.sessions]) await ctx.runMutation(api.auth.logout, { token });
    return { ok: true, checks };
  },
});
