/**
 * Step gating for the three-step customer ticket flow.
 *
 * Pure so the gates can be unit tested and so the stepper UI and the submit
 * button agree on when a step is complete.
 */

export const CUSTOMER_STEP_COUNT = 3;

export type CustomerStep = 1 | 2 | 3;

export const CUSTOMER_STEPS: Array<{ step: CustomerStep; titleKey: "stepDetails" | "stepMedia" | "stepReview" }> = [
  { step: 1, titleKey: "stepDetails" },
  { step: 2, titleKey: "stepMedia" },
  { step: 3, titleKey: "stepReview" },
];

export const TITLE_MAX_LENGTH = 100;
export const DESCRIPTION_MAX_LENGTH = 10_000;

export type CustomerTicketDraft = {
  title: string;
  description: string;
  mediaCount: number;
  annotationCount: number;
};

/** Stable codes, localized through the shared error table. */
export type StepIssue = "REQUIRED_TITLE" | "TITLE_TOO_LONG" | "DESCRIPTION_TOO_LONG";

export function stepIssues(step: CustomerStep, draft: CustomerTicketDraft): StepIssue[] {
  const issues: StepIssue[] = [];
  if (step === 1) {
    if (!draft.title.trim()) issues.push("REQUIRED_TITLE");
    if (draft.title.trim().length > TITLE_MAX_LENGTH) issues.push("TITLE_TOO_LONG");
    if (draft.description.trim().length > DESCRIPTION_MAX_LENGTH) issues.push("DESCRIPTION_TOO_LONG");
  }
  return issues;
}

export function isStepComplete(step: CustomerStep, draft: CustomerTicketDraft) {
  return stepIssues(step, draft).length === 0;
}

/** A step opens only once every earlier step is complete. */
export function canEnterStep(step: CustomerStep, draft: CustomerTicketDraft) {
  for (let earlier = 1; earlier < step; earlier += 1) {
    if (!isStepComplete(earlier as CustomerStep, draft)) return false;
  }
  return true;
}

export function highestReachableStep(draft: CustomerTicketDraft): CustomerStep {
  if (!isStepComplete(1, draft)) return 1;
  if (!isStepComplete(2, draft)) return 2;
  return 3;
}

/** Keeps the active step inside the range the draft has unlocked. */
export function clampStep(requested: number, draft: CustomerTicketDraft): CustomerStep {
  const bounded = Math.min(Math.max(Math.trunc(requested), 1), CUSTOMER_STEP_COUNT) as CustomerStep;
  const highest = highestReachableStep(draft);
  return (bounded > highest ? highest : bounded) as CustomerStep;
}

export function canSubmitDraft(draft: CustomerTicketDraft) {
  return isStepComplete(1, draft) && isStepComplete(2, draft) && isStepComplete(3, draft);
}

export type StepState = "completed" | "active" | "inactive";

export function stepState(step: CustomerStep, activeStep: CustomerStep, draft: CustomerTicketDraft): StepState {
  if (step === activeStep) return "active";
  if (step < activeStep && isStepComplete(step, draft)) return "completed";
  return "inactive";
}
