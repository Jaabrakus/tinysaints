import assert from "node:assert/strict";
import test from "node:test";

import { buildDiffLines, diffStats } from "../lib/kimi-code-diff.ts";

test("lines up context, deletions, and additions with one-based line numbers", () => {
  const lines = buildDiffLines("a\nb\nc", "a\nB\nc\nd");

  assert.deepEqual(lines, [
    { type: "context", text: "a", oldNo: 1, newNo: 1 },
    { type: "del", text: "b", oldNo: 2 },
    { type: "add", text: "B", newNo: 2 },
    { type: "context", text: "c", oldNo: 3, newNo: 3 },
    { type: "add", text: "d", newNo: 4 },
  ]);
  assert.deepEqual(diffStats(lines), { added: 2, removed: 1 });
});

test("handles empty, identical, and trailing-newline inputs", () => {
  assert.deepEqual(buildDiffLines("", "x\ny"), [
    { type: "add", text: "x", newNo: 1 },
    { type: "add", text: "y", newNo: 2 },
  ]);
  assert.deepEqual(buildDiffLines("a\nb", "a\nb"), [
    { type: "context", text: "a", oldNo: 1, newNo: 1 },
    { type: "context", text: "b", oldNo: 2, newNo: 2 },
  ]);
  assert.deepEqual(buildDiffLines("", ""), []);
  assert.deepEqual(buildDiffLines("same\n", "same\n"), [
    { type: "context", text: "same", oldNo: 1, newNo: 1 },
  ]);
});

test("returns null before allocating an oversized LCS matrix", () => {
  const big = Array.from({ length: 2000 }, (_, index) => `line${index}`).join("\n");
  assert.equal(buildDiffLines(big, `${big}\nextra`), null);
});

test("returns null when one side exceeds the output-row cap", () => {
  const huge = Array.from({ length: 6000 }, (_, index) => `line${index}`).join("\n");
  assert.equal(buildDiffLines("one line", huge), null);
});
