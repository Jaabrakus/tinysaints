import { env } from "cloudflare:workers";
import { getPublicPlaytestSnapshot, RoomError } from "../../../lib/room-service";
import { assembleGeneratedArtifact, validateArtifactFiles, validateArtifactJavascript } from "../../../lib/starter-artifact";

export const runtime = "edge";

const PHASER_VERSION = "4.2.0";
const PHASER_URL = `https://cdn.jsdelivr.net/npm/phaser@${PHASER_VERSION}/dist/phaser.min.js`;
const NONCE = "make-room-public-runtime";

function base64(bytes: Uint8Array) {
  let value = "";
  for (let index = 0; index < bytes.length; index += 32_768) {
    value += String.fromCharCode(...bytes.subarray(index, index + 32_768));
  }
  return btoa(value);
}

function json(value: unknown) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function parse(files: Array<{ path: string; content: string }>, path: string) {
  try {
    return JSON.parse(files.find((file) => file.path === path)?.content ?? "null") as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  try {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const snapshot = await getPublicPlaytestSnapshot(token);
    const files = validateArtifactFiles(snapshot.files);
    const byPath = new Map(files.map((file) => [file.path, file.content]));
    const project = parse(files, "project.make.json");
    const packageFile = parse(files, "package.json");
    const makeRoom = packageFile?.makeRoom as Record<string, unknown> | undefined;
    const dependencies = packageFile?.dependencies as Record<string, unknown> | undefined;
    const phaser = project?.kind === "game" && project?.runtime === "phaser-4" && makeRoom?.runtime === "phaser" && dependencies?.phaser === PHASER_VERSION;
    const requestedEntry =
      (typeof makeRoom?.entry === "string" && makeRoom.entry) ||
      (typeof project?.entry === "string" && project.entry) ||
      "src/app.js";
    const entry = byPath.has(requestedEntry) ? requestedEntry : byPath.has("src/app.js") ? "src/app.js" : "";
    const source = entry ? validateArtifactJavascript(byPath.get(entry) ?? "") : "";
    const assets = (await Promise.all(snapshot.assets.map(async (asset) => {
      const object = await env.UPLOADS.get(asset.objectKey);
      if (!object) return null;
      return {
        id: asset.id,
        name: asset.name,
        kind: asset.kind,
        contentType: asset.contentType,
        sha256: asset.sha256,
        url: `data:${asset.contentType};base64,${base64(new Uint8Array(await object.arrayBuffer()))}`,
      };
    }))).filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
    const manifest = { list: assets, byName: Object.fromEntries(assets.map((asset) => [asset.name, asset])) };
    const policy = phaser
      ? `default-src 'none'; script-src 'nonce-${NONCE}' ${PHASER_URL}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
      : `default-src 'none'; script-src 'nonce-${NONCE}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    let document = assembleGeneratedArtifact({ html: byPath.get("index.html") ?? "", css: byPath.get("styles.css") ?? "" }, snapshot.build.name);
    document = document.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/>/, `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    document = document.replace("</body>", [
      `<script nonce="${NONCE}">globalThis.makeRoomAssets=${json(manifest)};</script>`,
      phaser ? `<script nonce="${NONCE}" src="${PHASER_URL}"></script>` : "",
      source ? `<script nonce="${NONCE}" data-make-room-entry>${source}</script>` : "",
      "</body>",
    ].join(""));
    return new Response(document, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${policy}; frame-ancestors 'self'`,
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    const status = error instanceof RoomError ? error.status : 500;
    const message = error instanceof RoomError ? error.message : "The public playtest could not open.";
    return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
}
