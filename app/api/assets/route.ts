import { env } from "cloudflare:workers";
import {
  createProjectAssetRecord,
  deleteProjectAssetRecord,
  getIdentity,
  getProjectAssetRecord,
  getRoomState,
  RoomError,
  type ProjectAssetKind,
} from "../../../lib/room-service";

export const runtime = "edge";

const allowedTypes = new Map<string, ProjectAssetKind>([
  ["image/png", "image"],
  ["image/jpeg", "image"],
  ["image/webp", "image"],
  ["image/gif", "image"],
  ["audio/mpeg", "audio"],
  ["audio/ogg", "audio"],
  ["audio/wav", "audio"],
  ["audio/x-wav", "audio"],
  ["audio/mp4", "audio"],
]);

function bucket() {
  const uploads = env.UPLOADS;
  if (!uploads) {
    throw new RoomError("Shared asset storage is not available yet. Publish the storage-enabled version first.", 503);
  }
  return uploads;
}

function errorResponse(error: unknown) {
  if (error instanceof RoomError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("Project asset request failed", error);
  return Response.json({ error: "The shared asset library hit an unexpected problem." }, { status: 500 });
}

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity) throw new RoomError("Sign in with ChatGPT to use project assets.", 401);
  return identity;
}

async function digestHex(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeDownloadName(value: string) {
  return value.replace(/["\\/\r\n]/g, "-").slice(0, 100) || "asset";
}

function sameSiteRequest(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "same-site" || site === "none";
}

export async function GET(request: Request) {
  try {
    const identity = await identityOrThrow();
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    const assetId = url.searchParams.get("asset") ?? "";
    if (!room || !assetId) throw new RoomError("Choose a room asset to open.");
    const asset = await getProjectAssetRecord(room, identity, assetId);
    const object = await bucket().get(asset.objectKey);
    if (!object) throw new RoomError("The stored asset bytes are missing.", 404);
    const download = url.searchParams.get("download") === "1";
    return new Response(object.body, {
      headers: {
        "content-type": asset.contentType,
        "content-length": String(asset.byteCount),
        "content-disposition": `${download ? "attachment" : "inline"}; filename="${safeDownloadName(asset.name)}"`,
        "cache-control": "private, max-age=60",
        "x-content-type-options": "nosniff",
        "cross-origin-resource-policy": "same-origin",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!sameSiteRequest(request)) throw new RoomError("Cross-site uploads are not allowed.", 403);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 6 * 1024 * 1024) throw new RoomError("Assets may be at most 5 MB.", 413);
    if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
      throw new RoomError("Upload one image or audio file.", 415);
    }
    const identity = await identityOrThrow();
    const form = await request.formData();
    const room = String(form.get("room") ?? "").trim();
    const file = form.get("file");
    if (!room) throw new RoomError("Choose a room before uploading.");
    if (!(file instanceof File)) throw new RoomError("Choose an image or audio file.");
    const kind = allowedTypes.get(file.type.toLowerCase());
    if (!kind) {
      throw new RoomError("Use PNG, JPEG, WebP, GIF, MP3, OGG, WAV, or M4A assets.", 415);
    }
    if (file.size < 1 || file.size > 5 * 1024 * 1024) {
      throw new RoomError("Assets must be between 1 byte and 5 MB.", 413);
    }

    const bytes = await file.arrayBuffer();
    const sha256 = await digestHex(bytes);
    const objectKey = `objects/${sha256}`;
    await bucket().put(objectKey, bytes, {
      httpMetadata: { contentType: file.type },
      customMetadata: { sha256 },
    });
    try {
      await createProjectAssetRecord(room, identity, {
        name: file.name,
        kind,
        contentType: file.type.toLowerCase(),
        objectKey,
        sha256,
        byteCount: file.size,
      });
    } catch (error) {
      throw error;
    }
    return Response.json(await getRoomState(room, identity), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    if (!sameSiteRequest(request)) throw new RoomError("Cross-site asset changes are not allowed.", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON asset request.", 415);
    }
    const identity = await identityOrThrow();
    const payload = (await request.json()) as { room?: string; assetId?: string };
    const room = payload.room?.trim() ?? "";
    const assetId = payload.assetId?.trim() ?? "";
    if (!room || !assetId) throw new RoomError("Choose an asset to remove.");
    const removed = await deleteProjectAssetRecord(room, identity, assetId);
    if (removed.orphaned) await bucket().delete(removed.objectKey);
    return Response.json(await getRoomState(room, identity));
  } catch (error) {
    return errorResponse(error);
  }
}
