import assert from "node:assert/strict";
import test from "node:test";

import { mergeForkSourceSnapshots } from "../lib/fork-merge.ts";

function files(html, css) {
  return [
    { path: "index.html", content: html, language: "html" },
    { path: "styles.css", content: css, language: "css" },
  ];
}

test("combines non-overlapping parent and fork work", () => {
  const result = mergeForkSourceSnapshots(
    files("base html", "base css"),
    files("parent html", "base css"),
    files("base html", "fork css"),
  );

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.branchChangedPaths, ["styles.css"]);
  assert.deepEqual(result.mergedPaths, ["styles.css"]);
  assert.deepEqual(result.files, files("parent html", "fork css"));
});

test("accepts identical edits and preserves unchanged target work", () => {
  const result = mergeForkSourceSnapshots(
    files("base html", "base css"),
    files("same html", "parent css"),
    files("same html", "base css"),
  );

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.branchChangedPaths, ["index.html"]);
  assert.deepEqual(result.mergedPaths, []);
  assert.deepEqual(result.files, files("same html", "parent css"));
});

test("stops when both sides changed the same file differently", () => {
  const result = mergeForkSourceSnapshots(
    files("base html", "base css"),
    files("parent html", "base css"),
    files("fork html", "base css"),
  );

  assert.deepEqual(result.conflicts, ["index.html"]);
  assert.deepEqual(result.files, files("parent html", "base css"));
});
