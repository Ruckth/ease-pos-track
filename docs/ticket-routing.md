# Ticket routing for the zero-user launch

Named staff open **Ticket routing** from the Project workspace menu. The assignment filter offers **Mine** and **Unassigned**. Ticket detail shows the assignment, hold, availability warning and staff-only history. Assignment and Ticket status are independent. The Owner configures responsibility areas, ordered primary and fallback staff, intake staff and a separate intake backup. Named staff set their own Project availability. An Owner changing someone else's availability supplies a reason.

Customers and staff can choose the Project's Thai or English product and symptom labels and mark a Ticket Restricted. When named staff review the classification, a single active area match with an eligible assignee enters the staff review queue for up to 24 hours. Unknown codes, conflicts, cases without a match and restricted Tickets stay in manual work. Accepting a current suggestion selects the first eligible primary or fallback and uses the same manual assignment operation as a direct human choice. Dismissal and expiry preserve the Ticket. Holds and deliberate manual changes, including unassignment, take precedence over suggestions.

Changing the mapping advances the rule revision and policy generation. Roster and availability changes advance the policy generation. Review rechecks the Ticket version, current policy, availability and Project access.

## Named identity and inbox

- Routing checks the admitted session's durable `staffId` and the current staff name, role and status. During a named pilot, eligible staff must be reconciled into the current epoch. Assignment history keeps its attribution across session rotation. Roster membership grants no Project access. [Routing identity adapter](../convex/domain/routing_identity.ts)
- A new assignment and its assignee's private inbox update commit together. Changing a hold or clearing an assignment sends no new assignment alert. The Ticket records the event that started the current assignee's interval (`assigneeEventId`). An assignment alert displays only during that interval, so reassigning A to B and back to A shows A one new alert. The recipient can open the Ticket from the Project inbox. Customer inboxes receive status updates only.
- Saving the intake roster updates inbox memberships in the same transaction. Active intake staff and the backup receive new Ticket alerts by default and can opt out per Project. Removing and re-adding someone keeps their earlier intake alerts hidden. Opting out hides that category's existing alerts at once, and opting back in shows only later alerts.

## External routing is paused

On 19 November 2026 the team confirmed it had no approved routing evaluation dataset. The launch has no broker, provider egress, promotion path, evaluation screen or evaluation API. The signed T3 connection check is independent. The research notes record the proposed broker and the evidence required to revisit it. [Routing research](research/t3code-phase1/04-responsibilities-and-delegation.md)

## Criteria for future measurement

1. Use approved sanitized cases. Freeze the development set and the tuned rule revision. Measure correct actionable suggestions, wrong routes, abstentions and operator corrections. Keep the local rules if correct coverage reaches 90%.
2. If a gap persists, preregister a separate holdout of at least 50 distinct cases where the tuned rule abstains or conflicts. Keep the holdout disjoint from rule authoring and tuning. Independently label it before scoring and record its share of the in-scope Ticket population. Compare on the same denominator, including errors and abstentions. To justify broker work, require a gain of at least 10 percentage points, no additional wrong routes and projected cost within the Owner-approved cap. Record the rule revision, provider terms, projected cost, both scores and the budget decision.
3. Any later initial assignment requires its own release decision. Sample at least 100 consecutive distinct eligible cases, have two staff independently label them before seeing the output, and resolve disagreements. Require at least 95% correct with abstentions in the denominator, zero data-policy violations, and verified pause and manual overrides. Keep restricted Tickets out of any provider input. Meeting these measurement targets grants no live routing access.

## Disposable local verification

- `pnpm test:browser --grep 'named staff use rules'` uses seeded named staff, submits a Ticket through the Thai customer form, reviews and accepts a local suggestion, uses Mine, then reassigns and holds the Ticket. It checks customer visibility and zero upload requests.
- `pnpm test:convex tests/convex/ticket-routing.test.ts` checks manual routing, suggestion idempotency and concurrency, access, rosters, availability and inbox alerts.
- `pnpm test:one tests/ticket_routing.test.ts tests/function_policies.test.ts` checks the local rule and the launch's allowed routing registrations and schema. Run `pnpm convex:local` after registration or schema changes to verify the local push and regenerate bindings.
