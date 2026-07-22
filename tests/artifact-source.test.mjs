import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleArtifactFiles,
  extractArtifactSource,
  generatedSourceFromFiles,
  makeStarterSource,
  sourceFilesFromGenerated,
} from "../lib/starter-artifact.ts";

test("compiles and reopens the canonical two-file starter source", () => {
  const files = sourceFilesFromGenerated(makeStarterSource("source room"));
  const artifact = assembleArtifactFiles(files, "source room");
  const reopened = extractArtifactSource(artifact);

  assert.deepEqual(reopened, generatedSourceFromFiles(files));
  assert.match(artifact, /default-src 'none'/);
  assert.match(artifact, /script-src 'none'/);
  assert.match(artifact, /connect-src 'none'/);
});

test("requires one unique index.html and styles.css snapshot", () => {
  assert.throws(
    () =>
      generatedSourceFromFiles([
        { path: "index.html", content: "<main>one</main>" },
      ]),
    /index\.html and styles\.css/,
  );
  assert.throws(
    () =>
      generatedSourceFromFiles([
        { path: "index.html", content: "<main>one</main>" },
        { path: "index.html", content: "<main>two</main>" },
      ]),
    /duplicate source paths/,
  );
});

test("manual and model source share the same capability boundary", () => {
  const safeCss = { path: "styles.css", content: "main { color: black; }" };

  assert.throws(
    () =>
      assembleArtifactFiles(
        [
          { path: "index.html", content: '<main onclick="alert(1)">bad</main>' },
          safeCss,
        ],
        "unsafe",
      ),
    /capability that previews do not allow/,
  );
  assert.throws(
    () =>
      assembleArtifactFiles(
        [
          { path: "index.html", content: "<main>bad css</main>" },
          { path: "styles.css", content: "body { background: url(https://example.com/x); }" },
        ],
        "unsafe",
      ),
    /external asset/,
  );
});
