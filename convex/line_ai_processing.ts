import { v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import { createLine } from "./adapters/line";
import { validateLineAttachment } from "./adapters/line_attachment";
import { lineAiLimits, scanLineRequest, type LineAiFile } from "./adapters/line_ai_provider";
import { assistantEnrollment } from "./domain/line_ai_review";
import { lineAiReleaseEnabled, openLineAiKey } from "./domain/line_ai_settings";
import { internalJobAction, internalJobMutation, internalJobQuery } from "./functions";
import { openLineSecret } from "./line_crypto";
import { lineAiSuggestion } from "./line_ai_review_schema";
import { parseTicketReference } from "../shared/ticket-numbers";

const intake = { intakeId: v.id("lineAiIntakes") };
const lease = { ...intake, leaseId: v.string(), connectionRevision: v.number() };
const leaseMs = 90_000;
const dayMs = 24 * 60 * 60_000;
const scansPerProjectPerDay = 60;
const maxAttempts = 2;
const scanWarnings = new Set([
  "LINE_AI_KEY_REJECTED", "LINE_AI_KEY_UNREADABLE", "LINE_AI_QUOTA_EXCEEDED", "LINE_AI_RATE_LIMITED",
  "LINE_AI_DAILY_LIMIT", "LINE_AI_REQUEST_REJECTED", "LINE_AI_RESPONSE_INVALID",
]);

const manualSuggestion = {
  intent: "clarify", title: null, description: null, ticketNumber: null, reply: null, evidence: [],
} satisfies Infer<typeof lineAiSuggestion>;

export const recover = internalJobMutation({
  name: "line_ai_processing:recover", args: {},
  handler: async (ctx) => {
    if (!await lineAiReleaseEnabled(ctx)) return;
    const now = Date.now();
    const [waiting, expired] = await Promise.all([
      ctx.db.query("lineAiIntakes").withIndex("by_state_available",
        q => q.eq("state", "pending").lte("availableAt", now - 30_000)).take(25),
      ctx.db.query("lineAiIntakes").withIndex("by_state_lease",
        q => q.eq("state", "processing").lte("leaseExpiresAt", now)).take(25),
    ]);
    for (const row of [...waiting, ...expired]) {
      if (row.expiresAt > now) await ctx.scheduler.runAfter(0, internal.line_ai_processing.process, { intakeId: row._id });
    }
  },
});

export const claim = internalJobMutation({
  name: "line_ai_processing:claim", args: intake,
  handler: async (ctx, { intakeId }) => {
    if (!await lineAiReleaseEnabled(ctx)) return null;
    const row = await ctx.db.get(intakeId);
    const now = Date.now();
    if (!row || (row.state !== "pending" && row.state !== "processing") || row.expiresAt <= now
      || row.availableAt > now || (row.leaseExpiresAt ?? 0) > now) return null;
    const enrollment = await assistantEnrollment(ctx, row);
    if (!enrollment) {
      await ctx.db.patch(intakeId, {
        state: "ignored", text: "", files: [], leaseId: undefined, leaseExpiresAt: undefined, updatedAt: now,
      });
      return null;
    }
    const leaseId = crypto.randomUUID();
    const connectionRevision = enrollment.connection.revision;
    const attempt = row.attempt + 1;
    await ctx.db.patch(intakeId, { state: "processing", leaseId, leaseExpiresAt: now + leaseMs, attempt, updatedAt: now });
    await ctx.scheduler.runAfter(leaseMs, internal.line_ai_processing.process, { intakeId });
    return { row, ...enrollment, leaseId, connectionRevision, attempt };
  },
});

/** Reserve spend and recheck authority immediately before the external request. */
export const beginScan = internalJobMutation({
  name: "line_ai_processing:beginScan", args: lease,
  handler: async (ctx, { intakeId, leaseId, connectionRevision }) => {
    const row = await ctx.db.get(intakeId);
    const now = Date.now();
    if (!row || row.state !== "processing" || row.leaseId !== leaseId
      || (row.leaseExpiresAt ?? 0) <= now || row.expiresAt <= now
      || !await assistantEnrollment(ctx, { ...row, connectionRevision })) return "denied" as const;
    const day = Math.floor(now / dayMs);
    const usage = await ctx.db.query("lineAiUsage").withIndex("by_project_day",
      q => q.eq("projectId", row.projectId).eq("day", day)).unique();
    if (usage && usage.scans >= scansPerProjectPerDay) return "quota" as const;
    if (usage) await ctx.db.patch(usage._id, { scans: usage.scans + 1 });
    else await ctx.db.insert("lineAiUsage", { projectId: row.projectId, day, scans: 1 });
    return "approved" as const;
  },
});

export const authorizeDownload = internalJobQuery({
  name: "line_ai_processing:authorizeDownload", args: { ...lease, tokenCipher: v.string() },
  handler: async (ctx, { intakeId, leaseId, connectionRevision, tokenCipher }) => {
    const row = await ctx.db.get(intakeId);
    if (!row || row.state !== "processing" || row.leaseId !== leaseId || (row.leaseExpiresAt ?? 0) <= Date.now()) return false;
    const enrollment = await assistantEnrollment(ctx, { ...row, connectionRevision });
    return enrollment?.bot.tokenCipher === tokenCipher;
  },
});

function checkedSuggestion(suggestion: Infer<typeof lineAiSuggestion>, text: string) {
  if (suggestion.intent !== "close") return suggestion;
  const references = [...new Set((text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{4,}\b/gi) ?? []).map(value => value.toUpperCase()))];
  if (references.length === 1 && suggestion.ticketNumber?.toUpperCase() === references[0]
    && parseTicketReference(references[0])) return suggestion;
  return manualSuggestion;
}

export const finish = internalJobMutation({
  name: "line_ai_processing:finish",
  args: { ...lease, suggestion: lineAiSuggestion, warning: v.optional(v.string()) },
  handler: async (ctx, { intakeId, leaseId, connectionRevision, suggestion, warning }) => {
    const row = await ctx.db.get(intakeId);
    const now = Date.now();
    if (!row || row.state !== "processing" || row.leaseId !== leaseId || (row.leaseExpiresAt ?? 0) <= now) return;
    if (!await lineAiReleaseEnabled(ctx)) return;
    const enrollment = await assistantEnrollment(ctx, { ...row, connectionRevision });
    const reviewable = !!enrollment && row.expiresAt > now && suggestion.intent !== "skip";
    if (reviewable) await ctx.db.insert("lineAiDrafts", {
      intakeId, projectId: row.projectId, state: "review", suggestion: checkedSuggestion(suggestion, row.text),
      warning, connectionRevision, authorizationRevision: enrollment.connection.authorizationRevision ?? 0,
      createdAt: now, expiresAt: row.expiresAt,
    });
    await ctx.db.patch(intakeId, {
      state: reviewable ? "draft" : "ignored", leaseId: undefined, leaseExpiresAt: undefined,
      updatedAt: now, ...(reviewable ? {} : { text: "", files: [] }),
    });
  },
});

export const process = internalJobAction({
  name: "line_ai_processing:process", args: intake,
  handler: async (ctx, { intakeId }): Promise<void> => {
    const job = await ctx.runMutation(internal.line_ai_processing.claim, { intakeId });
    if (!job) return;
    const { row, bot, connection, leaseId, connectionRevision, attempt } = job;
    const scope = { intakeId, leaseId, connectionRevision };
    let suggestion: Infer<typeof lineAiSuggestion> = manualSuggestion;
    let warning: string | undefined;
    try {
      if (attempt > maxAttempts) throw new Error("LINE_AI_UNAVAILABLE");
      const files: LineAiFile[] = [];
      let fileBytes = 0;
      if (row.files.length) {
        const line = createLine(await openLineSecret(bot.tokenCipher));
        for (const file of row.files) {
          if (!await ctx.runQuery(internal.line_ai_processing.authorizeDownload, { ...scope, tokenCipher: bot.tokenCipher })) {
            throw new Error("LINE_AI_UNAVAILABLE");
          }
          try {
            if (file.type === "video") throw new Error("LINE_CONTENT_UNSUPPORTED");
            const content = await line.getContent(file.messageId);
            fileBytes += content.bytes.byteLength;
            if (fileBytes > lineAiLimits.totalBytes) throw new Error("LINE_CONTENT_TOO_LARGE");
            files.push(await validateLineAttachment(content.bytes, content.mimeType));
          } catch {
            warning = "LINE_AI_ATTACHMENT_UNAVAILABLE";
            break;
          }
        }
      }
      if (!warning) {
        const apiKey = await openLineAiKey(connection);
        const authorization = await ctx.runMutation(internal.line_ai_processing.beginScan, scope);
        if (authorization === "quota") throw new Error("LINE_AI_DAILY_LIMIT");
        if (authorization !== "approved") throw new Error("LINE_AI_UNAVAILABLE");
        suggestion = await scanLineRequest({ provider: connection.provider, model: connection.model, apiKey },
          { text: row.text, files });
      }
    } catch (error) {
      warning = error instanceof Error && scanWarnings.has(error.message) ? error.message : "LINE_AI_UNAVAILABLE";
    }
    await ctx.runMutation(internal.line_ai_processing.finish, { ...scope, suggestion, warning });
  },
});
