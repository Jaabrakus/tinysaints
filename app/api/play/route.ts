import { env } from "cloudflare:workers";
import {
  getIdentity,
  getPlayableProjectSnapshot,
  RoomError,
} from "../../../lib/room-service";
import {
  assembleGeneratedArtifact,
  validateArtifactFiles,
  validateArtifactJavascript,
} from "../../../lib/starter-artifact";

export const runtime = "edge";

const PHASER_VERSION = "4.2.0";
const PHASER_URL = `https://cdn.jsdelivr.net/npm/phaser@${PHASER_VERSION}/dist/phaser.min.js`;
const SCRIPT_NONCE = "make-room-runtime";

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function safeJson(value: unknown) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function parseJsonFile(files: Array<{ path: string; content: string }>, path: string) {
  const file = files.find((candidate) => candidate.path === path);
  if (!file) return null;
  try {
    return JSON.parse(file.content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function playableError(error: unknown) {
  const status = error instanceof RoomError ? error.status : 500;
  const message = error instanceof RoomError
    ? error.message
    : "The playable build could not be opened.";
  if (!(error instanceof RoomError)) console.error("Playable build failed", error);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10120e;color:#c9cec2;font:14px ui-monospace,monospace}main{max-width:36rem;padding:2rem;border:1px solid #34382f;border-radius:10px}strong{display:block;color:#caff45;margin-bottom:.6rem}</style></head><body><main><strong>PLAYABLE BUILD UNAVAILABLE</strong>${message.replace(/[<>&]/g, "")}</main></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function GET(request: Request) {
  try {
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Sign in with ChatGPT to play this build.", 401);
    const url = new URL(request.url);
    const slug = url.searchParams.get("room")?.trim() ?? "";
    const buildId = url.searchParams.get("build")?.trim() || undefined;
    if (!slug) throw new RoomError("Choose a room to play.");

    const snapshot = await getPlayableProjectSnapshot(slug, identity, buildId);
    const files = validateArtifactFiles(snapshot.files);
    const fileByPath = new Map(files.map((file) => [file.path, file.content]));
    const html = fileByPath.get("index.html") ?? "";
    const css = fileByPath.get("styles.css") ?? "";
    const projectManifest = parseJsonFile(files, "project.make.json");
    const packageManifest = parseJsonFile(files, "package.json");
    const packageRuntime = packageManifest?.makeRoom as Record<string, unknown> | undefined;
    const dependencies = packageManifest?.dependencies as Record<string, unknown> | undefined;
    const wantsPhaser =
      projectManifest?.kind === "game" &&
      projectManifest?.runtime === "phaser-4" &&
      packageRuntime?.runtime === "phaser" &&
      dependencies?.phaser === PHASER_VERSION;
    const configuredEntry =
      (typeof packageRuntime?.entry === "string" && packageRuntime.entry) ||
      (typeof projectManifest?.entry === "string" && projectManifest.entry) ||
      "src/app.js";
    const entryPath = fileByPath.has(configuredEntry)
      ? configuredEntry
      : fileByPath.has("src/app.js")
        ? "src/app.js"
        : "";
    const entrySource = entryPath ? validateArtifactJavascript(fileByPath.get(entryPath) ?? "") : "";

    const assets = await Promise.all(
      snapshot.assets.map(async (asset) => {
        const object = await env.UPLOADS.get(asset.objectKey);
        if (!object) return null;
        const bytes = new Uint8Array(await object.arrayBuffer());
        return {
          id: asset.id,
          name: asset.name,
          kind: asset.kind,
          contentType: asset.contentType,
          byteCount: asset.byteCount,
          sha256: asset.sha256,
          url: `data:${asset.contentType};base64,${bytesToBase64(bytes)}`,
        };
      }),
    );
    const assetList = assets.filter((asset): asset is NonNullable<typeof asset> => Boolean(asset));
    const assetByName = Object.fromEntries(assetList.map((asset) => [asset.name, asset]));
    const manifestScript = `globalThis.makeRoomAssets=${safeJson({ list: assetList, byName: assetByName })};`;

    let document = assembleGeneratedArtifact({ html, css }, snapshot.build.name);
    const metaPolicy = wantsPhaser
      ? `default-src 'none'; script-src 'nonce-${SCRIPT_NONCE}' ${PHASER_URL}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`
      : `default-src 'none'; script-src 'nonce-${SCRIPT_NONCE}'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
    document = document.replace(
      /<meta http-equiv="Content-Security-Policy" content="[^"]*"\s*\/>/,
      `<meta http-equiv="Content-Security-Policy" content="${metaPolicy}" />`,
    );
    const runtimeScripts = [
      `<script nonce="${SCRIPT_NONCE}">${manifestScript}</script>`,
      wantsPhaser ? `<script nonce="${SCRIPT_NONCE}" src="${PHASER_URL}"></script>` : "",
      entrySource ? `<script nonce="${SCRIPT_NONCE}" data-make-room-entry>${entrySource}</script>` : "",
    ].filter(Boolean).join("");
    document = document.replace("</body>", `${runtimeScripts}</body>`);

    return new Response(document, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": `${metaPolicy}; frame-ancestors 'self'`,
        "cache-control": "private, no-store",
        "cross-origin-resource-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-make-room-runtime": wantsPhaser ? `phaser-${PHASER_VERSION}` : "isolated-javascript",
      },
    });
  } catch (error) {
    return playableError(error);
  }
}
