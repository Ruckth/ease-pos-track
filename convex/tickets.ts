import { actorMutation, actorQuery, customerQuery, staffMutation, staffQuery } from "./functions";
import * as operations from "./domain/operations";

export const listTickets = staffQuery(operations.listTickets);
export const listMyTickets = customerQuery(operations.listMyTickets);
export const getTicket = actorQuery(operations.getTicket);
export const getTicketByTicketNumber = staffQuery(operations.getTicketByTicketNumber);
export const listTicketActivity = actorQuery(operations.listTicketActivity);
export const createTicket = actorMutation(operations.createTicket);
export const createTextTicket = actorMutation(operations.createTextTicket);
export const attachTicketMedia = staffMutation(operations.attachTicketMedia);
export const updateTicketStatus = staffMutation(operations.updateTicketStatus);
export const updateUrgencyScore = staffMutation(operations.updateUrgencyScore);
export const undoUrgencyScore = staffMutation(operations.undoUrgencyScore);
export const undoTicketStatus = staffMutation(operations.undoTicketStatus);
export const undoTicketEdit = actorMutation(operations.undoTicketEdit);
export const editTicket = actorMutation(operations.editTicket);
export const archiveTicket = actorMutation(operations.archiveTicket);
export const restoreTicket = staffMutation(operations.restoreTicket);
