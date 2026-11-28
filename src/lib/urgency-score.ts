type UrgencyBand = "unscored" | "low" | "medium" | "high" | "critical";

/** Stable visual bands for the staff board's 1-100 urgency scale. */
export function urgencyBand(score: number | undefined): UrgencyBand {
  if (score === undefined) return "unscored";
  if (score <= 25) return "low";
  if (score <= 50) return "medium";
  if (score <= 75) return "high";
  return "critical";
}

export const urgencyTone: Record<UrgencyBand, string> = {
  unscored: "border-slate-300 bg-slate-50 text-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:border-slate-700",
  low: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-700",
  medium: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-700",
  high: "border-orange-300 bg-orange-50 text-orange-800 dark:bg-orange-950 dark:text-orange-200 dark:border-orange-700",
  critical: "border-red-300 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 dark:border-red-700",
};

/** An urgency field draft: blank clears; otherwise a whole number from 1 to 100. */
export function parseUrgencyDraft(value: string): { valid: true; score: number | undefined } | { valid: false } {
  const text = value.trim();
  if (text === "") return { valid: true, score: undefined };
  if (!/^\d+$/.test(text)) return { valid: false };
  const score = Number(text);
  return score >= 1 && score <= 100 ? { valid: true, score } : { valid: false };
}
