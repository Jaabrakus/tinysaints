import {
  createPlaytestLink,
  getIdentity,
  getPlaytestDashboard,
  revokePlaytestLink,
  RoomError,
} from "../../../lib/room-service";

export const runtime = "edge";

async function identityOrThrow() {
  const identity = await getIdentity();
  if (!identity) throw new RoomError("Sign in with ChatGPT to manage playtests.", 401);
  return identity;
}

function fail(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Playtest management failed", error);
  return Response.json({ error: "Playtest sharing could not be updated." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const identity = await identityOrThrow();
    const slug = new URL(request.url).searchParams.get("room") ?? "";
    return Response.json(await getPlaytestDashboard(slug, identity), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return fail(error);
  }
}

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      throw new RoomError("Cross-site playtest changes are not allowed.", 403);
    }
    const identity = await identityOrThrow();
    const payload = (await request.json()) as { action?: string; room?: string; label?: string; linkId?: string };
    if (payload.action === "create") {
      const created = await createPlaytestLink(payload.room ?? "", identity, payload.label ?? "");
      return Response.json({ created, dashboard: await getPlaytestDashboard(payload.room ?? "", identity) }, { status: 201 });
    }
    if (payload.action === "revoke") {
      await revokePlaytestLink(payload.room ?? "", identity, payload.linkId ?? "");
      return Response.json(await getPlaytestDashboard(payload.room ?? "", identity));
    }
    throw new RoomError("That playtest action is not supported.");
  } catch (error) {
    return fail(error);
  }
}
