import { env } from "cloudflare:workers";
import { getExportProjectSnapshot, getIdentity, RoomError } from "../../../lib/room-service";
import { makeProjectTar } from "../../../lib/project-export";

export const runtime = "edge";

export async function GET(request: Request) {
  try {
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Sign in with ChatGPT to export this project.", 401);
    const url = new URL(request.url);
    const room = url.searchParams.get("room") ?? "";
    const status = url.searchParams.get("status") === "staged" ? "staged" : "published";
    if (!room) throw new RoomError("Choose a room to export.");
    const snapshot = await getExportProjectSnapshot(room, identity, status);
    if (snapshot.assets.length > 0 && !env.UPLOADS) {
      throw new RoomError("The shared asset store is not available for export yet.", 503);
    }
    const assetFiles = await Promise.all(
      snapshot.assets.map(async (asset) => {
        const object = await env.UPLOADS.get(asset.objectKey);
        if (!object) throw new RoomError(`The bytes for ${asset.name} are missing.`, 409);
        const safeName = asset.name.replace(/[\\/\u0000-\u001f\u007f]/g, "-").slice(0, 100);
        return {
          path: `assets/uploads/${asset.id.slice(0, 8)}-${safeName}`,
          name: asset.name,
          kind: asset.kind,
          contentType: asset.contentType,
          sha256: asset.sha256,
          content: new Uint8Array(await object.arrayBuffer()),
        };
      }),
    );
    const archive = makeProjectTar({
      slug: snapshot.room.slug,
      name: snapshot.room.name,
      revision: snapshot.room.revision,
      buildId: snapshot.build.id,
      version: snapshot.build.version,
      status: snapshot.build.status,
      files: snapshot.files,
      assets: assetFiles,
    });
    return new Response(archive, {
      headers: {
        "content-type": "application/x-tar",
        "content-disposition": `attachment; filename="${snapshot.room.slug}-v${snapshot.build.version}.tar"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof RoomError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Project export failed", error);
    return Response.json({ error: "The project export could not be created." }, { status: 500 });
  }
}
