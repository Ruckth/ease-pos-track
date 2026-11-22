export const ROUTING_LIMITS = {
  areas: 20, staff: 50, rules: 200, vocabulary: 50,
  suggestionMs: 24 * 60 * 60 * 1000,
} as const;

type Codes = { product?: string; symptom?: string; restricted: boolean; reviewed: boolean };
type Rule = { product: string; symptom: string; area: string };

export function evaluateTicketRule(
  classification: Codes | undefined,
  rules: readonly Rule[],
  allowed: { products: readonly string[]; symptoms: readonly string[]; areas: readonly string[] },
) {
  if (!classification?.reviewed || classification.restricted || !classification.product || !classification.symptom
    || !allowed.products.includes(classification.product) || !allowed.symptoms.includes(classification.symptom)) {
    return { kind: "manual" } as const;
  }
  const matches = new Set(rules.filter(rule => rule.product === classification.product
    && rule.symptom === classification.symptom && allowed.areas.includes(rule.area)).map(rule => rule.area));
  if (matches.size === 0) return { kind: "abstain" } as const;
  if (matches.size > 1) return { kind: "conflict" } as const;
  return { kind: "match", area: Array.from(matches)[0] } as const;
}

export type TicketRoutingClassification = { product?: string; symptom?: string; restricted: boolean };
export type TicketAssignmentFilter = "mine" | "unassigned";
