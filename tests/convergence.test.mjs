import assert from "node:assert/strict";
import test from "node:test";

import { projectChangesBetween } from "../lib/convergence.ts";

function file(path, content, language = "text") {
  return { path, content, language };
}

test("reduces a presented fork to deterministic complete-file changes", () => {
  const changes = projectChangesBetween(
    [file("index.html", "before", "html"), file("old.md", "remove", "markdown"), file("styles.css", "same", "css")],
    [file("index.html", "after", "html"), file("new.js", "export const ready = true", "javascript"), file("styles.css", "same", "css")],
  );
  assert.deepEqual(changes, [
    { path: "index.html", content: "after" },
    { path: "new.js", content: "export const ready = true" },
    { path: "old.md", content: null },
  ]);
});

test("ignores unchanged fork files", () => {
  const files = [file("index.html", "same", "html"), file("styles.css", "same", "css")];
  assert.deepEqual(projectChangesBetween(files, files), []);
});
