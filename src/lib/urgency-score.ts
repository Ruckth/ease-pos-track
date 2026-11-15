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
  unscored: "border-slate-300 bg-slate-50 text-slate-600",
  low: "border-emerald-300 bg-emerald-50 text-emerald-800",
  medium: "border-amber-300 bg-amber-50 text-amber-800",
  high: "border-orange-300 bg-orange-50 text-orange-800",
  critical: "border-red-300 bg-red-50 text-red-800",
};
