import {
  createContribution,
  getIdentity,
  linkContributions,
  listContributions,
  RoomError,
  shareContribution,
  toggleContributionReaction,
} from "../../../lib/room-service";

export const runtime = "edge";

function failure(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Contribution API failed", error);
  return Response.json({ error: "The contribution could not be processed." }, { status: 500 });
}

async function identity() {
  const user = await getIdentity();
  if (!user) throw new RoomError("Choose a guest name to use the contribution inbox.", 401);
  return user;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    return Response.json(await listContributions(url.searchParams.get("room") ?? "", await identity(), url.searchParams.get("q") ?? ""), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) throw new RoomError("Use a JSON contribution request.", 415);
    const user = await identity();
    const body = await request.json() as Record<string, unknown>;
    const room = String(body.room ?? "");
    const action = String(body.action ?? "create");
    if (action === "create") {
      const id = await createContribution(room, user, {
        kind: String(body.kind ?? "context"),
        providerLabel: String(body.providerLabel ?? "Human"),
        title: String(body.title ?? "Untitled contribution"),
        summary: String(body.summary ?? ""),
        recommendation: String(body.recommendation ?? ""),
        files: Array.isArray(body.files) ? body.files.map(String) : [],
        lineRefs: Array.isArray(body.lineRefs) ? body.lineRefs as Array<{ path: string; start: number; end?: number }> : [],
        payload: body.payload && typeof body.payload === "object" ? body.payload as Record<string, unknown> : {},
        baseBuildId: typeof body.baseBuildId === "string" ? body.baseBuildId : undefined,
        parentContributionId: typeof body.parentContributionId === "string" ? body.parentContributionId : undefined,
        share: body.share === true,
      });
      return Response.json({ id, contributions: await listContributions(room, user) }, { status: 201 });
    }
    if (action === "share") await shareContribution(room, user, String(body.id ?? ""));
    else if (action === "react") await toggleContributionReaction(room, user, String(body.id ?? ""), String(body.reaction ?? ""));
    else if (action === "link") await linkContributions(room, user, String(body.sourceId ?? ""), String(body.targetId ?? ""), String(body.relation ?? ""));
    else throw new RoomError("That contribution action is unsupported.");
    return Response.json(await listContributions(room, user));
  } catch (error) {
    return failure(error);
  }
}
