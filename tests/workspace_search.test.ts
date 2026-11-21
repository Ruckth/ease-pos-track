import assert from "node:assert/strict";
import test from "node:test";
import {
  customerWorkspaceSearch,
  MAX_WORKSPACE_QUERY_LENGTH,
  parseWorkspaceSearch,
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
      lane: "new",
      ticket: "bad/id",
      panel: "unknown",
    })),
    "?project=POS",
  );
  assert.equal(
    stringifyWorkspaceSearch(customerWorkspaceSearch({ project: "_POS", filter: "all", ticket: "a".repeat(65) })),
    "",
  );
});

test("query text round-trips literally, including JSON-like and localized values", () => {
  for (const q of ["007", "null", "false", '"printer"', '{"look":"up"}', "  เครื่องพิมพ์ + & #  ", "a".repeat(MAX_WORKSPACE_QUERY_LENGTH)]) {
    const search = staffWorkspaceSearch(parseWorkspaceSearch(stringifyWorkspaceSearch({ q })));
    assert.equal(search.q, q);
  }
});
