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
    const archive = makeProjectTar({
      slug: snapshot.room.slug,
      name: snapshot.room.name,
      revision: snapshot.room.revision,
      buildId: snapshot.build.id,
      version: snapshot.build.version,
      status: snapshot.build.status,
      files: snapshot.files,
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
