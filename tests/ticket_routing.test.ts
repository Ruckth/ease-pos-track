import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTicketRule } from "../shared/ticket-routing";

const classification = { product: "printer", symptom: "blank", reviewed: true, restricted: false };
const codes = { products: ["printer"], symptoms: ["blank"], areas: ["hardware", "ops"] };
const hardware = { product: "printer", symptom: "blank", area: "hardware" };

test("only a single active area creates a local rule match", () => {
  assert.deepEqual(evaluateTicketRule(classification, [hardware, hardware], codes), { kind: "match", area: "hardware" });
  assert.deepEqual(evaluateTicketRule(classification, [hardware, { ...hardware, area: "ops" }], codes), { kind: "conflict" });
  assert.deepEqual(evaluateTicketRule(classification, [{ ...hardware, area: "retired" }], codes), { kind: "abstain" });
  for (const input of [undefined, { ...classification, reviewed: false }, { ...classification, restricted: true },
    { ...classification, product: "unknown" }]) assert.deepEqual(evaluateTicketRule(input, [hardware], codes), { kind: "manual" });
});
