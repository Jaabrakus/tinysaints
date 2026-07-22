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

test("merges files added inside a forked project folder", () => {
  const result = mergeForkSourceSnapshots(
    files("base html", "base css"),
    [...files("parent html", "base css"), { path: "notes/plan.md", content: "parent notes", language: "markdown" }],
    [...files("base html", "base css"), { path: "src/card.js", content: "export const card = true", language: "javascript" }],
  );

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.mergedPaths, ["src/card.js"]);
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["index.html", "notes/plan.md", "src/card.js", "styles.css"],
  );
});

test("carries a fork file removal into the converged snapshot", () => {
  const base = [
    ...files("base html", "base css"),
    { path: "notes/old.md", content: "remove me", language: "markdown" },
  ];
  const result = mergeForkSourceSnapshots(
    base,
    base,
    files("base html", "base css"),
  );

  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.mergedPaths, ["notes/old.md"]);
  assert.ok(!result.files.some((file) => file.path === "notes/old.md"));
});
