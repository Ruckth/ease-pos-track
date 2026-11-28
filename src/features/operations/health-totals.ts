export const healthKinds = ["cancellation", "intent_expiry", "rejected_upload", "ticket_purge"] as const;
export const healthStates = ["pending", "running", "completed", "failed", "superseded"] as const;

/** Sums each state across kinds from the same `kind:state` counters the table shows. */
export function stateTotals(counts: Record<string, number>) {
  return Object.fromEntries(healthStates.map(state =>
    [state, healthKinds.reduce((sum, kind) => sum + (counts[`${kind}:${state}`] ?? 0), 0)])) as Record<typeof healthStates[number], number>;
}
