const steps: [Intl.RelativeTimeFormatUnit, number][] = [["minute", 60], ["hour", 24], ["day", 7], ["week", 4.35], ["month", 12], ["year", Infinity]];

/** "3 hours ago" style text for a past or future timestamp; under a minute reads as now. */
export function formatRelativeTime(timestamp: number, now: number, language: "en" | "th") {
  const format = new Intl.RelativeTimeFormat(language === "th" ? "th-TH" : "en-US", { numeric: "auto" });
  let value = (timestamp - now) / 60_000;
  if (Math.abs(value) < 1) return format.format(0, "second");
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit);
    value /= size;
  }
  return format.format(Math.round(value), "year");
}
