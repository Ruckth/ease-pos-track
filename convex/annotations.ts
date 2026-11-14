import { actorMutation, actorQuery } from "./functions";
import * as operations from "./domain/operations";

export const listAnnotationActivity = actorQuery(operations.listAnnotationActivity);
export const addAnnotation = actorMutation(operations.addAnnotation);
export const updateAnnotation = actorMutation(operations.updateAnnotation);
export const undoAnnotationUpdate = actorMutation(operations.undoAnnotationUpdate);
export const removeAnnotation = actorMutation(operations.removeAnnotation);
export const restoreAnnotation = actorMutation(operations.restoreAnnotation);
