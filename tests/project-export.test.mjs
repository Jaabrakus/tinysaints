import assert from "node:assert/strict";
import test from "node:test";

import { makeProjectTar } from "../lib/project-export.ts";

function tarFiles(archive) {
  const decoder = new TextDecoder();
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (start, length) => decoder.decode(header.slice(start, start + length)).replace(/\0.*$/s, "");
    const name = read(0, 100);
    const prefix = read(345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(read(124, 12).trim(), 8);
    const content = decoder.decode(archive.slice(offset + 512, offset + 512 + size));
    files.set(path, content);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test("exports a deterministic Git-ready project with a dependency-free runner", () => {
  const archive = makeProjectTar({
    slug: "agent-room",
    name: "Agent room",
    revision: 7,
    buildId: "build-7",
    version: 3,
    status: "staged",
    files: [
      { path: "index.html", content: "<main>hello</main>", language: "html" },
      { path: "styles.css", content: "main{}", language: "css" },
      { path: "src/app.js", content: "console.log('ready')", language: "javascript" },
    ],
  });
  const files = tarFiles(archive);
  assert.equal(files.get("index.html"), "<main>hello</main>");
  assert.match(files.get("make-room.json"), /"revision": 7/);
  assert.match(files.get("package.json"), /node tools\/dev\.mjs/);
  assert.match(files.get("tools/dev.mjs"), /createServer/);
  assert.match(files.get(".gitignore"), /node_modules/);
  assert.equal(archive.length % 512, 0);
});
