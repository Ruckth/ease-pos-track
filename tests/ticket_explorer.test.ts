import assert from "node:assert/strict";
import test from "node:test";
import type { Id } from "../convex/_generated/dataModel";
import { createFilterQuery, createFilterRule } from "../src/components/reui/filters/filters-query";
import { dateBoundary, filterTickets, paginateTickets, sortTickets, type ExplorerTicket } from "../src/lib/ticket-explorer";
const ticket = (n: number, extra: Partial<ExplorerTicket> = {}): ExplorerTicket => ({ _id: String(n) as Id<"feedback">, _creationTime: n, ticketNumber: n, title: `Ticket ${n}`, description: "Printer", media: [], status: "new", createdAt: new Date(2026,8,15,12).getTime(), updatedAt: new Date(2026,8,16,12).getTime(), ...extra });
const rule = (field: string, value: unknown) => createFilterRule({ path: [field], operator: field.endsWith("At") ? "between" : "in", value });

test("search and multiple filters combine, any selected tag matches, missing tags do not", () => {
  const rows = [ticket(1,{tagIds:["a" as Id<"ticketTags">]}),ticket(2,{tagIds:["b" as Id<"ticketTags">],status:"done"}),ticket(3),ticket(4,{tagIds:["c" as Id<"ticketTags">]})];
  const query=createFilterQuery([rule("tags",["a","b"]),rule("status",["new"])]);
  assert.deepEqual(filterTickets(rows,"printer",query).map(r=>r.ticketNumber),[1]);
  assert.deepEqual(filterTickets(rows,"TKT-0001",query).map(r=>r.ticketNumber),[1]);
  assert.equal(filterTickets(rows,"no match",query).length,0);
  assert.equal(filterTickets(rows,"",createFilterQuery()).length,4);
});

test("date ranges include both whole local days and exclude the next midnight", () => {
  const start=dateBoundary("2026-09-15")!; const end=dateBoundary("2026-09-16",true)!;
  const rows=[ticket(1,{createdAt:start-1}),ticket(2,{createdAt:start}),ticket(3,{createdAt:end-1}),ticket(4,{createdAt:end})];
  assert.deepEqual(filterTickets(rows,"",createFilterQuery([rule("createdAt",["2026-09-15","2026-09-16"])] )).map(r=>r.ticketNumber),[2,3]);
  assert.equal(filterTickets(rows,"",createFilterQuery([rule("updatedAt",["2026-09-16","2026-09-16"])] )).length,4);
  assert.equal(dateBoundary("2026-02-30"),null);
  assert.equal(dateBoundary("invalid"),null);
});

test("negated chips use the inverse of their visible condition", () => {
  const condition={...rule("status",["done"]),negated:true};
  assert.deepEqual(filterTickets([ticket(1),ticket(2,{status:"done"})],"",createFilterQuery([condition])).map(r=>r.ticketNumber),[1]);
});

test("sort before pagination, stable ties, no mutation, and clamp on live deletion", () => {
  const rows=Array.from({length:51},(_,i)=>ticket(51-i));
  const sorted=sortTickets(rows,{field:"ticketNumber",direction:"asc"},[],"en");
  assert.equal(rows[0].ticketNumber,51);
  assert.deepEqual(paginateTickets(sorted,2,25).rows.map(r=>r.ticketNumber),Array.from({length:25},(_,i)=>i+26));
  assert.equal(paginateTickets(sorted,3,25).rows[0].ticketNumber,51);
  assert.equal(paginateTickets(sorted.slice(0,5),3,25).page,1);
  assert.deepEqual(paginateTickets([],9,10),{page:1,pages:1,rows:[]});
  assert.deepEqual(sortTickets([ticket(2),ticket(1)],{field:"createdAt",direction:"desc"},[],"en").map(r=>r.ticketNumber),[1,2]);
});

test("urgency ranges never treat unset as zero and unset sorts last in either direction", () => {
  const rows=[ticket(1),ticket(2,{urgencyScore:1}),ticket(3,{urgencyScore:100}),ticket(4,{urgencyScore:50})];
  const range=createFilterQuery([createFilterRule({path:["urgencyScore"],operator:"between",value:[1,50]})]);
  assert.deepEqual(filterTickets(rows,"",range).map(r=>r.ticketNumber),[2,4]);
  assert.deepEqual(filterTickets(rows,"",createFilterQuery([createFilterRule({path:["urgencyScore"],operator:"unset"})])).map(r=>r.ticketNumber),[1]);
  assert.deepEqual(sortTickets(rows,{field:"urgencyScore",direction:"asc"},[],"en").map(r=>r.ticketNumber),[2,4,3,1]);
  assert.deepEqual(sortTickets(rows,{field:"urgencyScore",direction:"desc"},[],"en").map(r=>r.ticketNumber),[3,4,2,1]);
});
