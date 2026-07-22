import { generateConvergencePatch, ModelProviderError } from "../../../lib/model-provider";
import {
  acquireGenerationLease,
  getConvergenceContext,
  getIdentity,
  getRoomState,
  releaseGenerationLease,
  RoomError,
  stageAgentProjectPatch,
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
      return Response.json({ error: "Cross-site convergence requests are not allowed." }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json({ error: "Use a JSON convergence request." }, { status: 415 });
    }
    const identity = await getIdentity();
    if (!identity) {
      return Response.json({ error: "Sign in with ChatGPT before converging forks." }, { status: 401 });
    }
    const payload = (await request.json()) as { slug?: string };
    const slug = payload.slug ?? "tiny-plans";
    lease = await acquireGenerationLease(slug, identity);
    const context = await getConvergenceContext(slug, identity);
    const proposal = await generateConvergencePatch({
      room: { name: context.room.name, note: context.room.note },
      messages: context.messages,
      current: { version: context.published.version, files: context.currentFiles },
      branches: context.branches.map((branch) => ({
        name: branch.name,
        ownerName: branch.ownerName,
        version: branch.version,
        changes: branch.changes,
      })),
    });
    await stageAgentProjectPatch(slug, identity, {
      expectedRevision: context.room.revision,
      baseBuildId: context.published.id,
      changes: proposal.patches,
      sourceKind: "convergence",
      title: proposal.proposalTitle,
      summary: proposal.summary,
      rationale: proposal.rationale,
      changeNotes: proposal.changes,
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
    console.error("Fork convergence failed", error);
    return Response.json({ error: "The room could not finish convergence. Try again." }, { status: 500 });
  } finally {
    if (lease) {
      try {
        await releaseGenerationLease(lease.roomId, lease.leaseId, lease.userId);
      } catch (releaseError) {
        console.error("Convergence lease cleanup failed", releaseError);
      }
    }
  }
}
