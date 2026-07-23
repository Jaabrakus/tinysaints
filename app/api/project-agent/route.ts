import { generateProjectPatch, ModelProviderError } from "../../../lib/model-provider";
import {
  acquireGenerationLease,
  getIdentity,
  getProjectAgentContext,
  getRoomState,
  releaseGenerationLease,
  RoomError,
  stageAgentProjectPatch,
} from "../../../lib/room-service";

export const runtime = "edge";

export async function POST(request: Request) {
  let lease: { roomId: string; leaseId: string; userId: string } | null = null;
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      throw new RoomError("Cross-site project-agent requests are not allowed.", 403);
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON project-agent request.", 415);
    }
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Sign in with ChatGPT to use the project AI.", 401);
    const payload = (await request.json()) as { slug?: string; instruction?: string };
    const slug = payload.slug?.trim() ?? "";
    const instruction = payload.instruction?.trim() ?? "";
    if (!instruction || instruction.length > 2_000) {
      throw new RoomError("Give the project AI a task between 1 and 2,000 characters.");
    }
    lease = await acquireGenerationLease(slug, identity);
    const context = await getProjectAgentContext(slug, identity);
    const proposal = await generateProjectPatch({
      room: { name: context.room.name, note: context.room.note },
      messages: context.messages,
      current: { version: context.working.version, files: context.files },
      instruction,
    });
    await stageAgentProjectPatch(slug, identity, {
      expectedRevision: context.room.revision,
      baseBuildId: context.working.id,
      changes: proposal.patches,
      sourceKind: "project-agent",
      title: proposal.proposalTitle,
      summary: proposal.summary,
      rationale: proposal.rationale,
      changeNotes: proposal.changes,
    });
    return Response.json(await getRoomState(slug, identity), { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof RoomError || error instanceof ModelProviderError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    console.error("Project AI failed", error);
    return Response.json({ error: "The project AI could not finish this task." }, { status: 500 });
  } finally {
    if (lease) {
      try {
        await releaseGenerationLease(lease.roomId, lease.leaseId, lease.userId);
      } catch (releaseError) {
        console.error("Project AI lease cleanup failed", releaseError);
      }
    }
  }
}
