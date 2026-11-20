import { actorQuery, staffMutation, staffQuery } from "./functions";
import * as policy from "./domain/routing_policy";
import * as assignment from "./domain/ticket_assignment";
import * as suggestions from "./domain/routing_suggestions";

export const getVocabulary = actorQuery({ name: "ticket_routing:getVocabulary", ...policy.getVocabulary });
export const getSettings = staffQuery({ name: "ticket_routing:getSettings", ...policy.getSettings });
export const saveConfiguration = staffMutation({ name: "ticket_routing:saveConfiguration", ...policy.saveConfiguration });
export const setAvailability = staffMutation({ name: "ticket_routing:setAvailability", ...policy.setAvailability });
export const assign = staffMutation({ name: "ticket_routing:assign", ...assignment.assign });
export const getAssignment = staffQuery({ name: "ticket_routing:getAssignment", ...assignment.getAssignment });
export const classify = staffMutation({ name: "ticket_routing:classify", ...suggestions.classify });
export const checkRule = staffMutation({ name: "ticket_routing:checkRule", ...suggestions.checkRule });
export const listSuggestions = staffQuery({ name: "ticket_routing:listSuggestions", ...suggestions.listSuggestions });
export const reviewSuggestion = staffMutation({ name: "ticket_routing:reviewSuggestion", ...suggestions.reviewSuggestion });
