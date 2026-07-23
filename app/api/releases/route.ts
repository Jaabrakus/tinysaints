import { getCoreProposalForRelease, getIdentity, RoomError } from "../../../lib/room-service";

export const runtime = "edge";

type GithubRef = { object?: { sha?: string }; message?: string };
type GithubChecks = { check_runs?: Array<{ name?: string; status?: string; conclusion?: string }> };

function failure(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Core release failed", error);
  return Response.json({ error: "The protected release bridge failed." }, { status: 500 });
}

async function github<T>(repository: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "x-github-api-version": "2022-11-28", "user-agent": "make-room-core-release" },
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new RoomError(payload.message || "GitHub rejected the protected release.", response.status >= 500 ? 502 : 409);
  return payload;
}

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") throw new RoomError("Cross-site release actions are not allowed.", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new RoomError("Use a JSON release request.", 415);
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Choose a name before releasing.", 401);
    const body = await request.json() as { room?: string; contributionId?: string };
    const coreSlug = process.env.CORE_ROOM_SLUG?.trim();
    const repository = process.env.GITHUB_RELEASE_REPOSITORY?.trim();
    const token = process.env.GITHUB_RELEASE_TOKEN?.trim();
    const targetBranch = process.env.GITHUB_RELEASE_BRANCH?.trim() || "main";
    if (!coreSlug || !repository || !token) throw new RoomError("The Core Studio release bridge is not configured yet.", 503);
    if (body.room !== coreSlug) throw new RoomError("Only the protected Core Studio can release the platform.", 403);
    const proposal = await getCoreProposalForRelease(coreSlug, identity, String(body.contributionId ?? ""));
    if (proposal.repository !== repository) throw new RoomError("That proposal targets a different repository.", 409);

    const sourceRef = await github<GithubRef>(repository, token, `/git/ref/heads/${proposal.branch.split("/").map(encodeURIComponent).join("/")}`);
    if (sourceRef.object?.sha !== proposal.commitSha) throw new RoomError("The proposal branch changed after the room reviewed it.", 409);
    const checks = await github<GithubChecks>(repository, token, `/commits/${proposal.commitSha}/check-runs`);
    const validation = (checks.check_runs ?? []).find((check) => check.name === "build-and-test");
    if (!validation || validation.status !== "completed") throw new RoomError("The isolated Core build and tests must finish before promotion.", 409);
    if (validation.conclusion !== "success") throw new RoomError("The isolated Core build or tests failed. Fix the proposal before promotion.", 409);
    await github(repository, token, `/git/refs/heads/${targetBranch.split("/").map(encodeURIComponent).join("/")}`, { method: "PATCH", body: JSON.stringify({ sha: proposal.commitSha, force: false }) });
    return Response.json({ commitSha: proposal.commitSha, commitUrl: `https://github.com/${repository}/commit/${proposal.commitSha}`, backing: proposal.backing, threshold: proposal.threshold }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
