import { getIdentity, getRoomState, RoomError } from "../../../lib/room-service";

export const runtime = "edge";

type GithubRef = { object?: { sha?: string } };
type GithubCommit = { tree?: { sha?: string } };
type GithubCreated = { sha?: string; html_url?: string };

function failure(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Core release failed", error);
  return Response.json({ error: "The protected release bridge failed." }, { status: 500 });
}

async function github<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "make-room-core-release",
      ...(init?.headers ?? {}),
    },
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new RoomError(payload.message || "GitHub rejected the protected release.", response.status >= 500 ? 502 : 409);
  return payload;
}

export async function POST(request: Request) {
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) throw new RoomError("Use a JSON release request.", 415);
    const identity = await getIdentity();
    if (!identity) throw new RoomError("Choose a guest name before releasing.", 401);
    const body = await request.json() as { room?: string; buildId?: string };
    const coreSlug = process.env.CORE_ROOM_SLUG?.trim();
    const repository = process.env.GITHUB_RELEASE_REPOSITORY?.trim();
    const token = process.env.GITHUB_RELEASE_TOKEN?.trim();
    const branch = process.env.GITHUB_RELEASE_BRANCH?.trim() || "main";
    if (!coreSlug || !repository || !token) throw new RoomError("The Core Studio release bridge is not configured yet.", 503);
    if (body.room !== coreSlug) throw new RoomError("Only the protected Core Studio can release the platform.", 403);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w./-]+$/.test(branch)) throw new RoomError("The protected repository configuration is invalid.", 500);

    const state = await getRoomState(coreSlug, identity);
    if (!state.room.canInvite) throw new RoomError("Only the Core Studio owner can promote a release.", 403);
    if (state.staged) throw new RoomError("Ship the majority-backed proposal before releasing it.", 409);
    if (!state.published || state.published.id !== body.buildId) throw new RoomError("Release the latest immutable Core Studio build.", 409);
    const files = state.published.files;
    if (!files.length || files.length > 200) throw new RoomError("The release snapshot must contain between 1 and 200 files.", 409);

    const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
    const ref = await github<GithubRef>(`/repos/${repository}/git/ref/heads/${encodedBranch}`, token);
    const parentSha = ref.object?.sha;
    if (!parentSha) throw new RoomError("The protected release branch is unavailable.", 502);
    const parent = await github<GithubCommit>(`/repos/${repository}/git/commits/${parentSha}`, token);
    if (!parent.tree?.sha) throw new RoomError("The protected repository tree is unavailable.", 502);

    const entries = await Promise.all(files.map(async (file: { path: string; content: string }) => {
      const blob = await github<GithubCreated>(`/repos/${repository}/git/blobs`, token, { method: "POST", body: JSON.stringify({ content: file.content, encoding: "utf-8" }) });
      if (!blob.sha) throw new RoomError(`GitHub could not store ${file.path}.`, 502);
      return { path: file.path, mode: "100644", type: "blob", sha: blob.sha };
    }));
    const tree = await github<GithubCreated>(`/repos/${repository}/git/trees`, token, { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) });
    if (!tree.sha) throw new RoomError("GitHub could not create the release tree.", 502);
    const commit = await github<GithubCreated>(`/repos/${repository}/git/commits`, token, {
      method: "POST",
      body: JSON.stringify({ message: `Release ${state.room.name} v${state.published.version}`, tree: tree.sha, parents: [parentSha] }),
    });
    if (!commit.sha) throw new RoomError("GitHub could not create the release commit.", 502);
    await github(`/repos/${repository}/git/refs/heads/${encodedBranch}`, token, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
    return Response.json({ commitSha: commit.sha, commitUrl: `https://github.com/${repository}/commit/${commit.sha}` }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
