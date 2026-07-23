import assert from "node:assert/strict";
import test from "node:test";

import {
  assembleArtifactFiles,
  extractArtifactSource,
  generatedSourceFromFiles,
  makeStarterProject,
} from "../lib/starter-artifact.ts";

test("compiles the bounded multi-file starter project", () => {
  const files = makeStarterProject("source room");
  const artifact = assembleArtifactFiles(files, "source room");
  const reopened = extractArtifactSource(artifact);

  assert.deepEqual(reopened, generatedSourceFromFiles(files));
  assert.deepEqual(
    files.map((file) => file.path),
    ["index.html", "project.make.json", "README.md", "src/app.js", "styles.css"],
  );
  assert.match(artifact, /default-src 'none'/);
  assert.match(artifact, /script-src 'nonce-make-room-project'/);
  assert.match(artifact, /const status = document\.querySelector/);
  assert.match(artifact, /connect-src 'none'/);
});

test("creates a playable multi-lane game studio project", () => {
  const files = makeStarterProject("spark run", "game");
  const artifact = assembleArtifactFiles(files, "spark run");

  assert.deepEqual(
    files.map((file) => file.path),
    [
      "assets/README.md",
      "audio/README.md",
      "index.html",
      "playtests/README.md",
      "project.make.json",
      "README.md",
      "src/app.js",
      "styles.css",
      "world/level-01.json",
    ],
  );
  assert.match(artifact, /<canvas id="game"/);
  assert.match(artifact, /requestAnimationFrame\(frame\)/);
  assert.match(artifact, /Collect every spark/);
  assert.match(files.find((file) => file.path === "project.make.json").content, /browser-canvas-2d/);
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
  assert.throws(
    () =>
      assembleArtifactFiles(
        [
          { path: "index.html", content: "<main>unsafe js</main>", language: "html" },
          { path: "styles.css", content: "main{}", language: "css" },
          {
            path: "src/app.js",
            content: "window.parent.postMessage('steal', '*')",
            language: "javascript",
          },
        ],
        "unsafe",
      ),
    /capability the preview does not allow/,
  );
});
