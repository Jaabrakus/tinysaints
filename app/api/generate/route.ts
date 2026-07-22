import { generateArtifact, ModelProviderError } from "../../../lib/model-provider";
import {
  acquireGenerationLease,
  getGenerationContext,
  getIdentity,
  getRoomState,
  releaseGenerationLease,
  RoomError,
  stageGeneratedArtifact,
} from "../../../lib/room-service";

export const runtime = "edge";

function requestIsCrossSite(request: Request) {
  const site = request.headers.get("sec-fetch-site");
  return Boolean(site && site !== "same-origin" && site !== "same-site" && site !== "none");
}

export async function POST(request: Request) {
  let lease: { roomId: string; leaseId: string; userId: string } | null = null;
  try {
    if (requestIsCrossSite(request)) {
      return Response.json({ error: "Cross-site build requests are not allowed." }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json({ error: "Use a JSON build request." }, { status: 415 });
    }

    const identity = await getIdentity();
    if (!identity) {
      return Response.json(
        { error: "Sign in with ChatGPT before synthesizing a room." },
        { status: 401 },
      );
    }

    const payload = (await request.json()) as { slug?: string };
    const slug = payload.slug ?? "tiny-plans";
    lease = await acquireGenerationLease(slug, identity);
    const context = await getGenerationContext(slug, identity);
    const artifact = await generateArtifact({
      room: {
        id: context.room.id,
        name: context.room.name,
        note: context.room.note,
      },
      messages: context.messages,
      published: {
        name: context.published.name,
        version: context.published.version,
        html: context.published.html,
      },
    });
    await stageGeneratedArtifact(slug, identity, artifact, {
      roomRevision: context.room.revision,
      publishedBuildId: context.published.id,
      stagedBuildId: context.stagedId,
      stagedVoterIds: context.stagedVoterIds,
      sourceMessageIds: context.messages.map((message) => message.id),
    });
    return Response.json(await getRoomState(slug, identity), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    if (error instanceof RoomError || error instanceof ModelProviderError) {
      return Response.json(
        {
          error: error.message,
          code: error instanceof ModelProviderError ? error.code : "room_error",
        },
        { status: error.status },
      );
    }
    console.error("Artifact generation failed", error);
    return Response.json(
      { error: "The room could not finish that build. Try again." },
      { status: 500 },
    );
  } finally {
    if (lease) {
      try {
        await releaseGenerationLease(lease.roomId, lease.leaseId, lease.userId);
      } catch (releaseError) {
        console.error("Generation lease cleanup failed", releaseError);
      }
    }
  }
}
