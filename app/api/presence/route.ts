import { getIdentity, RoomError, syncEditorPresence } from "../../../lib/room-service";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      throw new RoomError("Cross-site editor updates are not allowed.", 403);
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON editor update.", 415);
    }
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Sign in with ChatGPT to collaborate.", 401);
    const payload = (await request.json()) as {
      slug?: string;
      path?: string;
      baseBuildId?: string;
      cursorLine?: number;
      cursorColumn?: number;
      selectionEndLine?: number;
      selectionEndColumn?: number;
      content?: string;
      expectedDraftRevision?: number;
    };
    const result = await syncEditorPresence(payload.slug ?? "", identity, {
      path: payload.path ?? "",
      baseBuildId: payload.baseBuildId ?? "",
      cursorLine: payload.cursorLine,
      cursorColumn: payload.cursorColumn,
      selectionEndLine: payload.selectionEndLine,
      selectionEndColumn: payload.selectionEndColumn,
      content: payload.content,
      expectedDraftRevision: payload.expectedDraftRevision,
    });
    return Response.json(result, { status: result.conflict ? 409 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Editor presence failed", error);
    return Response.json({ error: "Live collaboration could not sync." }, { status: 500 });
  }
}
