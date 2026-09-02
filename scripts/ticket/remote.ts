import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { toStoredTicketStatus, type TicketStatus } from "./status";

export type TicketDocument = Doc<"feedback">;
export type CurrentSession = {
  role: "staff" | "customer";
  expiresAt: number;
  customerId: string | null;
  email: string | null;
};

export interface TicketRemote {
  login(url: string, password: string, clientId: string): Promise<{ token: string; expiresAt: number }>;
  currentSession(url: string, token: string): Promise<CurrentSession | null>;
  logout(url: string, token: string): Promise<void>;
  list(url: string, token: string, includeArchived: boolean): Promise<TicketDocument[]>;
  get(url: string, token: string, ticketNumber: number, includeArchived: boolean): Promise<TicketDocument | null>;
  create(url: string, token: string, input: { title: string; description: string; requestId: string }): Promise<{ ticket: TicketDocument; created: boolean; requestId: string }>;
  update(url: string, token: string, input: { ticketNumber: number; title?: string; description?: string; expectedVersion: number }): Promise<TicketDocument>;
  changeStatus(url: string, token: string, input: { ticketNumber: number; status: TicketStatus; expectedVersion: number }): Promise<TicketDocument>;
  archive(url: string, token: string, ticketNumber: number, expectedVersion: number): Promise<TicketDocument>;
  restore(url: string, token: string, ticketNumber: number, expectedVersion: number): Promise<TicketDocument>;
}

export class ConvexTicketRemote implements TicketRemote {
  private client(url: string) {
    return new ConvexHttpClient(url, { logger: false, skipConvexDeploymentUrlCheck: true });
  }

  async login(url: string, password: string, clientId: string) {
    return await this.client(url).mutation(api.auth.login, { password, clientId });
  }

  async currentSession(url: string, token: string) {
    return await this.client(url).query(api.auth.currentSession, { token });
  }

  async logout(url: string, token: string) {
    await this.client(url).mutation(api.auth.logout, { token });
  }

  async list(url: string, token: string, includeArchived: boolean) {
    await this.ensureNumbering(url, token);
    return await this.client(url).query(api.feedback.listFeedback, { token, includeDeleted: includeArchived });
  }

  async get(url: string, token: string, ticketNumber: number, includeArchived: boolean) {
    await this.ensureNumbering(url, token);
    return await this.client(url).query(api.feedback.getFeedbackByTicketNumber, {
      token,
      ticketNumber,
      includeDeleted: includeArchived,
    });
  }

  async create(url: string, token: string, input: { title: string; description: string; requestId: string }) {
    return await this.client(url).mutation(api.feedback.createTextFeedback, { token, ...input });
  }

  async update(url: string, token: string, input: { ticketNumber: number; title?: string; description?: string; expectedVersion: number }) {
    const current = await this.requireTicket(url, token, input.ticketNumber, false);
    await this.client(url).mutation(api.feedback.editFeedback, {
      token,
      id: current._id,
      title: input.title ?? current.title,
      description: input.description ?? current.description,
      expectedVersion: input.expectedVersion,
    });
    return await this.requireTicket(url, token, input.ticketNumber, false);
  }

  async changeStatus(url: string, token: string, input: { ticketNumber: number; status: TicketStatus; expectedVersion: number }) {
    const current = await this.requireTicket(url, token, input.ticketNumber, false);
    await this.client(url).mutation(api.feedback.updateFeedbackStatus, {
      token,
      id: current._id,
      status: toStoredTicketStatus(input.status),
      expectedVersion: input.expectedVersion,
    });
    return await this.requireTicket(url, token, input.ticketNumber, false);
  }

  async archive(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    const current = await this.requireTicket(url, token, ticketNumber, false);
    await this.client(url).mutation(api.feedback.archiveFeedback, { token, id: current._id, expectedVersion });
    return await this.requireTicket(url, token, ticketNumber, true);
  }

  async restore(url: string, token: string, ticketNumber: number, expectedVersion: number) {
    const current = await this.requireTicket(url, token, ticketNumber, true);
    await this.client(url).mutation(api.feedback.restoreFeedback, { token, id: current._id, expectedVersion });
    return await this.requireTicket(url, token, ticketNumber, false);
  }

  private async requireTicket(url: string, token: string, ticketNumber: number, includeArchived: boolean) {
    const ticket = await this.get(url, token, ticketNumber, includeArchived);
    if (!ticket) throw new Error("FEEDBACK_NOT_FOUND");
    return ticket;
  }

  private async ensureNumbering(url: string, token: string) {
    await this.client(url).mutation(api.feedback.ensureTicketNumbers, { token });
  }
}
