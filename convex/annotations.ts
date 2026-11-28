import { actorMutation, actorQuery } from "./functions";
import * as operations from "./domain/operations";

export const listAnnotationActivity = actorQuery({ name: "annotations:listAnnotationActivity", ...operations.listAnnotationActivity });
export const pageAnnotationActivity = actorQuery({ name: "annotations:pageAnnotationActivity", ...operations.pageAnnotationActivity });
export const addAnnotation = actorMutation({ name: "annotations:addAnnotation", ...operations.addAnnotation });
export const updateAnnotation = actorMutation({ name: "annotations:updateAnnotation", ...operations.updateAnnotation });
export const undoAnnotationUpdate = actorMutation({ name: "annotations:undoAnnotationUpdate", ...operations.undoAnnotationUpdate });
export const removeAnnotation = actorMutation({ name: "annotations:removeAnnotation", ...operations.removeAnnotation });
export const restoreAnnotation = actorMutation({ name: "annotations:restoreAnnotation", ...operations.restoreAnnotation });
