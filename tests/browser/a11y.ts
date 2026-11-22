// Targeted axe scans for Ticket states the browser journeys already reach.
// A scan covers the whole document so content behind a modal that is not
// properly hidden is still reported. Exclusions are scoped to one rule and
// selector and carry a reason, owner and review date.
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "playwright";

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/** `match` is tested against each failing node's selector and opening HTML. */
export type Exclusion = { rule: string; match: RegExp; reason: string; owner: string; review: string };
/** Known, reviewed findings. Keep this list short and dated; remove entries once fixed. */
export const EXCLUSIONS: Exclusion[] = [{
  rule: "label-content-name-mismatch",
  match: /<button[^>]*data-ticket-id=/,
  reason: "Ticket row buttons show the status (or Archive) between the number and title, but aria-label is \"View POS-n · title\" without it (WCAG 2.5.3). Speech users saying the visible text may not match. Found by this scan on 2026-11-19.",
  owner: "frontend maintainer (src/components/ticket-card.tsx)",
  review: "2026-12-19",
}];

export type Finding = { rule: string; impact: string | null | undefined; help: string; targets: string[] };

export async function axeFindings(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const findings: Finding[] = [];
  for (const violation of results.violations) {
    const targets = violation.nodes
      .filter(node => !EXCLUSIONS.some(exclusion => exclusion.rule === violation.id && exclusion.match.test(`${node.target.join(" ")} ${node.html}`)))
      .map(node => node.target.join(" "));
    if (targets.length) findings.push({ rule: violation.id, impact: violation.impact, help: violation.help, targets });
  }
  return { label, findings };
}

export function formatFindings({ label, findings }: { label: string; findings: Finding[] }) {
  return `${label}: ${findings.length} axe rule(s) failed\n` + findings.map(finding =>
    `  - ${finding.rule} (${finding.impact ?? "n/a"}): ${finding.help}\n` + finding.targets.slice(0, 5).map(target => `      ${target}`).join("\n")).join("\n");
}

/** Fails with a readable list of rules and targets. */
export async function expectAccessible(page: Page, label: string) {
  const result = await axeFindings(page, label);
  if (result.findings.length) throw new Error(formatFindings(result));
}
