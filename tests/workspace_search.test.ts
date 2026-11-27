import assert from "node:assert/strict";
import test from "node:test";
import {
  customerWorkspaceSearch,
  MAX_WORKSPACE_QUERY_LENGTH,
  parseWorkspaceSearch,
  projectWorkspaceSearch,
  resetWorkspaceFilters,
  staffWorkspaceSearch,
  stringifyWorkspaceSearch,
} from "../src/app/workspace-search";

test("staff links restore valid Project, Ticket, search, archive, lane and health", () => {
  assert.deepEqual(
    staffWorkspaceSearch(parseWorkspaceSearch("?project=pos&q=printer&archived=true&lane=in_progress&ticket=bad&panel=health")),
    { project: "POS", q: "printer", archived: true, lane: "in_progress", ticket: "bad", panel: "health" },
  );
});

test("customer links restore their own filter without staff-only parameters", () => {
  assert.deepEqual(
    customerWorkspaceSearch(parseWorkspaceSearch("?project=POS&filter=active&ticket=abc123&archived=true&lane=done&panel=health")),
    { project: "POS", filter: "active", ticket: "abc123" },
  );
});

test("defaults and unusable parameters are omitted without dropping valid siblings", () => {
  assert.equal(
    stringifyWorkspaceSearch(staffWorkspaceSearch({
      project: "POS",
      q: "a".repeat(MAX_WORKSPACE_QUERY_LENGTH + 1),
      archived: "false",
      lane: "unknown",
      ticket: "bad/id",
      panel: "unknown",
    })),
    "?project=POS",
  );
  assert.equal(
    stringifyWorkspaceSearch(customerWorkspaceSearch({ project: "_POS", filter: "archive", ticket: "a".repeat(65) })),
    "",
  );
});

test("query text round-trips literally, including JSON-like and localized values", () => {
  for (const q of ["007", "null", "false", '"printer"', '{"look":"up"}', "  เครื่องพิมพ์ + & #  ", "a".repeat(MAX_WORKSPACE_QUERY_LENGTH)]) {
    const search = staffWorkspaceSearch(parseWorkspaceSearch(stringifyWorkspaceSearch({ q })));
    assert.equal(search.q, q);
  }
});


test("staff workflow links retain the result view, status, assignment, and media section", () => {
  assert.deepEqual(
    staffWorkspaceSearch(parseWorkspaceSearch("?project=POS&view=focus&filter=waiting&assignment=mine&section=media&ticket=abc123&lane=new")),
    { project: "POS", view: "focus", filter: "waiting", assignment: "mine", section: "media", ticket: "abc123", lane: "new" },
  );
});

test("customer workflow links retain their search, All filter and media section", () => {
  assert.deepEqual(
    customerWorkspaceSearch(parseWorkspaceSearch("?q=007&filter=all&section=media&ticket=abc123&view=focus&assignment=mine")),
    { q: "007", filter: "all", section: "media", ticket: "abc123" },
  );
});

test("Project switches clear the previous Project's selection and result context", () => {
  const previous = staffWorkspaceSearch({
    project: "POS", ticket: "abc123", section: "media", q: "printer", view: "focus",
    filter: "waiting", assignment: "mine", lane: "waiting", archived: true,
  });
  assert.equal(stringifyWorkspaceSearch(projectWorkspaceSearch(previous, "OPS", "table")), "?project=OPS&view=table");
  assert.equal(stringifyWorkspaceSearch(projectWorkspaceSearch(previous, "OPS")), "?project=OPS");
});

test("clearing filters restores the default status and assignment in one entry and keeps search, view and Archive", () => {
  const open = { project: "POS", q: "printer", view: "queue" as const, lane: "new" as const, ticket: "t1", section: "media" as const };
  assert.deepEqual(resetWorkspaceFilters({ ...open, filter: "done", assignment: "mine" }, "active"),
    { project: "POS", q: "printer", view: "queue", lane: "new", ticket: undefined, section: undefined, filter: undefined, assignment: undefined });
  // Assignment alone keeps the open Ticket, as choosing an assignment does.
  assert.deepEqual(resetWorkspaceFilters({ ...open, assignment: "unassigned" }, "active"), { ...open, filter: undefined, assignment: undefined });
  // Board defaults to every status, so an explicit Active scope is the applied one.
  assert.equal(resetWorkspaceFilters({ ...open, view: "board", filter: "active" }, "all").filter, undefined);
  assert.equal(resetWorkspaceFilters({ ...open, filter: "active" }, "active").filter, undefined);
  const unchanged = [{ ...open }, { ...open, filter: "archive" as const, assignment: "mine" as const }, { ...open, archived: true as const }];
  for (const search of unchanged) assert.equal(resetWorkspaceFilters(search, "active"), search);
});
