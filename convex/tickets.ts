import { actorMutation, actorQuery, customerQuery, staffMutation, staffQuery } from "./functions";
import * as operations from "./domain/operations";

export const listTickets = staffQuery({ name: "tickets:listTickets", ...operations.listTickets });
export const listMyTickets = customerQuery({ name: "tickets:listMyTickets", ...operations.listMyTickets });
export const getTicket = actorQuery({ name: "tickets:getTicket", ...operations.getTicket });
export const getTicketByTicketNumber = staffQuery({ name: "tickets:getTicketByTicketNumber", ...operations.getTicketByTicketNumber });
export const listTicketActivity = actorQuery({ name: "tickets:listTicketActivity", ...operations.listTicketActivity });
export const createTicket = actorMutation({ name: "tickets:createTicket", ...operations.createTicket });
export const createTextTicket = actorMutation({ name: "tickets:createTextTicket", ...operations.createTextTicket });
export const attachTicketMedia = staffMutation({ name: "tickets:attachTicketMedia", ...operations.attachTicketMedia });
export const updateTicketStatus = staffMutation({ name: "tickets:updateTicketStatus", ...operations.updateTicketStatus });
export const updateUrgencyScore = staffMutation({ name: "tickets:updateUrgencyScore", ...operations.updateUrgencyScore });
export const undoUrgencyScore = staffMutation({ name: "tickets:undoUrgencyScore", ...operations.undoUrgencyScore });
export const undoTicketStatus = staffMutation({ name: "tickets:undoTicketStatus", ...operations.undoTicketStatus });
export const undoTicketEdit = actorMutation({ name: "tickets:undoTicketEdit", ...operations.undoTicketEdit });
export const editTicket = actorMutation({ name: "tickets:editTicket", ...operations.editTicket });
export const archiveTicket = actorMutation({ name: "tickets:archiveTicket", ...operations.archiveTicket });
export const restoreTicket = staffMutation({ name: "tickets:restoreTicket", ...operations.restoreTicket });
