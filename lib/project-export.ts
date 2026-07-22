import type { ArtifactSourceFile } from "./starter-artifact";

const encoder = new TextEncoder();

function octal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function writeText(target: Uint8Array, offset: number, width: number, value: string) {
  const bytes = encoder.encode(value);
  if (bytes.length > width) throw new Error(`Archive path is too long: ${value}`);
  target.set(bytes, offset);
}

function tarName(path: string) {
  const bytes = encoder.encode(path);
  if (bytes.length <= 100) return { name: path, prefix: "" };
  const slash = path.lastIndexOf("/");
  if (slash < 1) throw new Error(`Archive path is too long: ${path}`);
  const prefix = path.slice(0, slash);
  const name = path.slice(slash + 1);
  if (encoder.encode(prefix).length > 155 || encoder.encode(name).length > 100) {
    throw new Error(`Archive path is too long: ${path}`);
  }
  return { name, prefix };
}

function tarEntry(path: string, content: string) {
  const body = encoder.encode(content);
  const header = new Uint8Array(512);
  const split = tarName(path);
  writeText(header, 0, 100, split.name);
  writeText(header, 100, 8, octal(0o644, 8));
  writeText(header, 108, 8, octal(0, 8));
  writeText(header, 116, 8, octal(0, 8));
  writeText(header, 124, 12, octal(body.length, 12));
  writeText(header, 136, 12, octal(Math.floor(Date.now() / 1000), 12));
  header.fill(32, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 265, 32, "make-room");
  writeText(header, 297, 32, "make-room");
  writeText(header, 345, 155, split.prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padded = Math.ceil(body.length / 512) * 512;
  const entry = new Uint8Array(512 + padded);
  entry.set(header);
  entry.set(body, 512);
  return entry;
}

const devServer = `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 4173);
const types = { ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".md": "text/markdown" };

async function preview() {
  const [body, css, script] = await Promise.all([
    readFile(resolve(root, "index.html"), "utf8"),
    readFile(resolve(root, "styles.css"), "utf8"),
    readFile(resolve(root, "src/app.js"), "utf8").catch(() => ""),
  ]);
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><style>" + css + "</style></head><body>" + body + "<script>" + script.replaceAll("</script", "<\\/script") + "</script></body></html>";
}

createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/preview.html") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(await preview());
      return;
    }
    const file = resolve(root, pathname.slice(1));
    if (!file.startsWith(root + "/")) throw new Error("invalid path");
    response.setHeader("content-type", types[extname(file)] || "text/plain; charset=utf-8");
    response.end(await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end("Not found");
  }
}).listen(port, "127.0.0.1", () => console.log("Make Room preview: http://127.0.0.1:" + port));
`;

export function makeProjectTar(input: {
  slug: string;
  name: string;
  revision: number;
  buildId: string;
  version: number;
  status: string;
  files: ArtifactSourceFile[];
}) {
  const files = new Map(input.files.map((file) => [file.path, file.content]));
  files.set("make-room.json", JSON.stringify({
    schemaVersion: 1,
    room: input.slug,
    revision: input.revision,
    build: { id: input.buildId, version: input.version, status: input.status },
    entrypoints: { html: "index.html", css: "styles.css", javascript: "src/app.js" },
  }, null, 2) + "\n");
  if (!files.has(".gitignore")) files.set(".gitignore", "node_modules\n.env\n.env.*\ndist\n.DS_Store\n");
  if (!files.has("package.json")) files.set("package.json", JSON.stringify({
    name: input.slug,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: { dev: "node tools/dev.mjs", start: "node tools/dev.mjs" },
  }, null, 2) + "\n");
  if (!files.has("tools/dev.mjs")) files.set("tools/dev.mjs", devServer);

  const entries = Array.from(files.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => tarEntry(path, content));
  const length = entries.reduce((sum, entry) => sum + entry.length, 1024);
  const archive = new Uint8Array(length);
  let offset = 0;
  for (const entry of entries) {
    archive.set(entry, offset);
    offset += entry.length;
  }
  return archive;
}
