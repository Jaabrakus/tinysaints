import { RoomError, submitPlaytestFeedback } from "../../../lib/room-service";

export const runtime = "edge";

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      throw new RoomError("Cross-site feedback is not allowed.", 403);
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON feedback request.", 415);
    }
    const payload = (await request.json()) as { token?: string; displayName?: string; rating?: number; body?: string };
    await submitPlaytestFeedback(payload.token ?? "", {
      displayName: payload.displayName ?? "",
      rating: payload.rating ?? 0,
      body: payload.body ?? "",
    });
    return Response.json({ saved: true }, { status: 201 });
  } catch (error) {
    if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Playtest feedback failed", error);
    return Response.json({ error: "The feedback could not be saved." }, { status: 500 });
  }
}
