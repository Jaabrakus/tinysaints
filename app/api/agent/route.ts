import {
  authenticateAgentToken,
  getAgentProjectSnapshot,
  getRoomState,
  RoomError,
  stageAgentProjectPatch,
} from "../../../lib/room-service";

export const runtime = "edge";

function errorResponse(error: unknown) {
  if (error instanceof RoomError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("Agent gateway failed", error);
  return Response.json({ error: "The agent gateway hit an unexpected problem." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const identity = await authenticateAgentToken(request);
    const room = new URL(request.url).searchParams.get("room") ?? "";
    if (!room) throw new RoomError("Choose a room with ?room=room-slug.");
    return Response.json(await getAgentProjectSnapshot(room, identity), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON agent request.", 415);
    }
    const identity = await authenticateAgentToken(request);
    const payload = (await request.json()) as {
      room?: string;
      expectedRevision?: number;
      baseBuildId?: string;
      changes?: Array<{ path: string; content: string | null }>;
      agentLabel?: string;
      title?: string;
      summary?: string;
    };
    const room = payload.room ?? "";
    if (!room) throw new RoomError("The room slug is required.");
    await stageAgentProjectPatch(room, identity, {
      expectedRevision: payload.expectedRevision ?? -1,
      baseBuildId: payload.baseBuildId ?? "",
      changes: payload.changes ?? [],
      agentLabel: payload.agentLabel ?? "Personal agent",
      title: payload.title,
      summary: payload.summary,
    });
    return Response.json(await getRoomState(room, identity), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
