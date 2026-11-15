import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTagIds, normalizeTagName } from "../shared/tag-rules";

test("tag names normalize Unicode, spacing and case while retaining Thai", () => {
  assert.deepEqual(normalizeTagName("  ＰＯＳ   Support "), { name: "POS Support", normalizedName: "pos support" });
  assert.equal(normalizeTagName(" เครื่องพิมพ์ ").name, "เครื่องพิมพ์");
  for (const name of [" ", "x".repeat(33), "a\u200bb", "a\u0000b"]) assert.throws(() => normalizeTagName(name), /INVALID_TAG_NAME/);
  assert.deepEqual(normalizeTagIds(["b", "a", "b"]), ["a", "b"]);
  assert.throws(() => normalizeTagIds(Array(21).fill("a")), /TOO_MANY_TAGS/);
});
