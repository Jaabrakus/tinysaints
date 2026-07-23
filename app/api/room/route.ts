import {
  addMessage,
  createAgentToken,
  createRoomInvite,
  createRoom,
  editArtifactFile,
  forkRoom,
  getIdentity,
  getHomeRoomState,
  getRoomState,
  joinRoom,
  mergeForkToParent,
  presentForkToParent,
  revokeAgentToken,
  RoomError,
  shipBuild,
  stageAgentProjectPatch,
  toggleVote,
} from "../../../lib/room-service";

export const runtime = "edge";

function errorResponse(error: unknown) {
  if (error instanceof RoomError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  console.error("Room API failed", error);
  return Response.json(
    { error: "The room hit an unexpected problem. Try again." },
    { status: 500 },
  );
}

async function authenticatedIdentity() {
  const identity = await getIdentity();
  if (!identity) throw new RoomError("Sign in with ChatGPT to enter this room.", 401);
  return identity;
}

export async function GET(request: Request) {
  try {
    const identity = await authenticatedIdentity();
    const url = new URL(request.url);
    const slug = url.searchParams.get("slug");
    const state = slug
      ? await getRoomState(slug, identity)
      : await getHomeRoomState(identity);
    return Response.json(state, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      return Response.json({ error: "Cross-site room actions are not allowed." }, { status: 403 });
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return Response.json({ error: "Use a JSON room request." }, { status: 415 });
    }
    const identity = await authenticatedIdentity();
    const payload = (await request.json()) as {
      action?: string;
      slug?: string;
      body?: string;
      name?: string;
      template?: "game" | "app";
      token?: string;
      path?: string;
      content?: string | null;
      expectedRevision?: number;
      baseBuildId?: string;
      buildId?: string;
      agentLabel?: string;
      tokenId?: string;
      changes?: Array<{ path: string; content: string | null }>;
    };
    const action = payload.action ?? "";
    const slug = payload.slug ?? "tiny-plans";

    if (action === "join") {
      await joinRoom(slug, identity, payload.token ?? "");
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "invite") {
      return Response.json({ token: await createRoomInvite(slug, identity) });
    }
    if (action === "create-agent-token") {
      const token = await createAgentToken(identity, payload.name ?? "Personal coding agent");
      return Response.json({ token, state: await getRoomState(slug, identity) }, { status: 201 });
    }
    if (action === "revoke-agent-token") {
      await revokeAgentToken(identity, payload.tokenId ?? "");
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "message") {
      await addMessage(slug, identity, payload.body ?? "");
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "edit-file" || action === "agent-file" || action === "delete-file") {
      await editArtifactFile(slug, identity, {
        path: payload.path ?? "",
        content: action === "delete-file" ? null : payload.content ?? "",
        expectedRevision: payload.expectedRevision ?? -1,
        baseBuildId: payload.baseBuildId ?? "",
        agentLabel: action === "agent-file" ? payload.agentLabel ?? "Personal agent" : undefined,
      });
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "edit-project") {
      await stageAgentProjectPatch(slug, identity, {
        changes: payload.changes ?? [],
        expectedRevision: payload.expectedRevision ?? -1,
        baseBuildId: payload.baseBuildId ?? "",
        title: "Team workspace checkpoint",
        summary: `${payload.changes?.length ?? 0} draft files checkpointed for group review.`,
      });
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "vote") {
      await toggleVote(slug, identity, {
        roomRevision: payload.expectedRevision ?? -1,
        buildId: payload.buildId ?? "",
      });
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "ship") {
      await shipBuild(slug, identity);
      return Response.json(await getRoomState(slug, identity));
    }
    if (action === "fork") {
      return Response.json({ slug: await forkRoom(slug, identity) }, { status: 201 });
    }
    if (action === "merge-parent") {
      return Response.json(
        { slug: await mergeForkToParent(slug, identity) },
        { status: 201 },
      );
    }
    if (action === "present-parent") {
      return Response.json(
        { slug: await presentForkToParent(slug, identity) },
        { status: 201 },
      );
    }
    if (action === "create") {
      return Response.json(
        { slug: await createRoom(identity, payload.name ?? "", payload.template ?? "app") },
        { status: 201 },
      );
    }

    throw new RoomError("That room action is not supported.");
  } catch (error) {
    return errorResponse(error);
  }
}
