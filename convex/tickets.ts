import { actorMutation, actorQuery, staffMutation, staffQuery } from "./functions";
import * as operations from "./domain/operations";

import * as reads from "./domain/reads";
import * as tags from "./domain/tags";

export const listTicketTags = staffQuery({ name: "tickets:listTicketTags", ...tags.listTicketTags });
export const createTicketTag = staffMutation({ name: "tickets:createTicketTag", ...tags.createTicketTag });
export const setTicketTags = staffMutation({ name: "tickets:setTicketTags", ...tags.setTicketTags });

export const pageTickets = actorQuery({ name: "tickets:pageTickets", ...reads.pageTickets });
export const pageTicketDetails = staffQuery({ name: "tickets:pageTicketDetails", ...reads.pageTicketDetails });
export const searchTickets = actorQuery({ name: "tickets:searchTickets", ...reads.searchTickets });
export const laneTotals = staffQuery({ name: "tickets:laneTotals", ...reads.laneTotals });
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
