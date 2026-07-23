import { createContribution, getIdentity, getRoomState, RoomError } from "../../../lib/room-service";

export const runtime = "edge";

type GitTree = { tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }> };
type GitRef = { object?: { sha?: string } };
type GitCommit = { tree?: { sha?: string } };
type GitCreated = { sha?: string; content?: string; encoding?: string; message?: string };

const ignored = /^(?:node_modules|dist|\.next|\.wrangler|coverage)\//;
const binary = /\.(?:png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz|mp[34]|mov|wav|ogg)$/i;

function cleanPath(value: string) {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.length > 240 || path.startsWith("/") || path.includes("..") || path.includes("//")) throw new RoomError("Choose a safe repository file path.");
  return path;
}

function config() {
  const room = process.env.CORE_ROOM_SLUG?.trim();
  const repository = process.env.GITHUB_RELEASE_REPOSITORY?.trim();
  const token = process.env.GITHUB_RELEASE_TOKEN?.trim();
  const branch = process.env.GITHUB_RELEASE_BRANCH?.trim() || "main";
  if (!room || !repository || !token) throw new RoomError("The Core Studio repository bridge is not configured yet.", 503);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[\w./-]+$/.test(branch)) throw new RoomError("The protected repository configuration is invalid.", 500);
  return { room, repository, token, branch };
}

async function github<T>(repository: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "make-room-core-studio",
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 204) return {} as T;
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new RoomError(payload.message || "GitHub rejected the repository request.", response.status === 404 ? 404 : 409);
  return payload;
}

async function member() {
  const identity = await getIdentity();
  if (!identity) throw new RoomError("Choose a name before entering the Core Studio.", 401);
  const settings = config();
  const state = await getRoomState(settings.room, identity);
  if (!state.room.isCore) throw new RoomError("This room is not the protected Core Studio.", 403);
  return { identity, state, settings };
}

function failure(error: unknown) {
  if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
  console.error("Core repository bridge failed", error);
  return Response.json({ error: "The Core Studio repository bridge failed." }, { status: 500 });
}

export async function GET(request: Request) {
  try {
    const { settings } = await member();
    const url = new URL(request.url);
    const requestedPath = url.searchParams.get("path");
    if (requestedPath) {
      const path = cleanPath(requestedPath);
      const file = await github<GitCreated>(settings.repository, settings.token, `/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(settings.branch)}`);
      if (file.encoding !== "base64" || typeof file.content !== "string") throw new RoomError("That repository item is not a readable text file.", 415);
      const bytes = Uint8Array.from(atob(file.content.replace(/\s/g, "")), (character) => character.charCodeAt(0));
      if (bytes.byteLength > 300_000) throw new RoomError("That source file is too large for the browser editor.", 413);
      return Response.json({ path, sha: file.sha, content: new TextDecoder().decode(bytes) }, { headers: { "cache-control": "no-store" } });
    }
    const tree = await github<GitTree>(settings.repository, settings.token, `/git/trees/${encodeURIComponent(settings.branch)}?recursive=1`);
    const files = (tree.tree ?? []).filter((item) => item.type === "blob" && item.path && !ignored.test(item.path) && !binary.test(item.path) && (item.size ?? 0) <= 300_000)
      .slice(0, 2500).map((item) => ({ path: item.path!, sha: item.sha ?? "", byteCount: item.size ?? 0 }));
    return Response.json({ repository: settings.repository, branch: settings.branch, files }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") throw new RoomError("Cross-site Core Studio actions are not allowed.", 403);
    if (!request.headers.get("content-type")?.includes("application/json")) throw new RoomError("Use a JSON Core Studio request.", 415);
    const { identity, settings } = await member();
    const body = await request.json() as { title?: string; summary?: string; changes?: Array<{ path?: string; content?: string | null }> };
    const title = String(body.title ?? "Core Studio proposal").trim().slice(0, 100);
    const summary = String(body.summary ?? "").trim().slice(0, 1600);
    const changes = (body.changes ?? []).slice(0, 40).map((change) => ({ path: cleanPath(String(change.path ?? "")), content: change.content }));
    if (!changes.length || changes.some((change) => change.content !== null && typeof change.content !== "string")) throw new RoomError("Add at least one complete file change.");
    if (changes.some((change) => typeof change.content === "string" && new TextEncoder().encode(change.content).byteLength > 300_000)) throw new RoomError("Keep each proposed source file under 300 KB.", 413);

    const encodedBranch = settings.branch.split("/").map(encodeURIComponent).join("/");
    const ref = await github<GitRef>(settings.repository, settings.token, `/git/ref/heads/${encodedBranch}`);
    const parentSha = ref.object?.sha;
    if (!parentSha) throw new RoomError("The Core Studio branch is unavailable.", 502);
    const parent = await github<GitCommit>(settings.repository, settings.token, `/git/commits/${parentSha}`);
    if (!parent.tree?.sha) throw new RoomError("The Core Studio repository tree is unavailable.", 502);
    const entries = await Promise.all(changes.map(async (change) => {
      if (change.content === null) return { path: change.path, mode: "100644", type: "blob", sha: null };
      const blob = await github<GitCreated>(settings.repository, settings.token, "/git/blobs", { method: "POST", body: JSON.stringify({ content: change.content, encoding: "utf-8" }) });
      if (!blob.sha) throw new RoomError(`GitHub could not store ${change.path}.`, 502);
      return { path: change.path, mode: "100644", type: "blob", sha: blob.sha };
    }));
    const tree = await github<GitCreated>(settings.repository, settings.token, "/git/trees", { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree: entries }) });
    if (!tree.sha) throw new RoomError("GitHub could not assemble the proposal tree.", 502);
    const commit = await github<GitCreated>(settings.repository, settings.token, "/git/commits", { method: "POST", body: JSON.stringify({ message: title, tree: tree.sha, parents: [parentSha] }) });
    if (!commit.sha) throw new RoomError("GitHub could not create the proposal commit.", 502);
    const proposalBranch = `make-room/proposal-${commit.sha.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`;
    await github(settings.repository, settings.token, "/git/refs", { method: "POST", body: JSON.stringify({ ref: `refs/heads/${proposalBranch}`, sha: commit.sha }) });

    const workflow = process.env.CORE_VALIDATION_WORKFLOW?.trim();
    if (workflow) await github(settings.repository, settings.token, `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { method: "POST", body: JSON.stringify({ ref: proposalBranch }) });
    const contributionId = await createContribution(settings.room, identity, {
      kind: "patch",
      providerLabel: "Core repository",
      title,
      summary: summary || `${changes.length} repository file${changes.length === 1 ? "" : "s"} proposed on ${proposalBranch}.`,
      files: changes.map((change) => change.path),
      payload: { repository: settings.repository, branch: proposalBranch, commitSha: commit.sha, validation: workflow ? "dispatched" : "not-configured" },
      share: true,
    });
    return Response.json({ contributionId, branch: proposalBranch, commitSha: commit.sha, commitUrl: `https://github.com/${settings.repository}/commit/${commit.sha}`, validation: workflow ? "dispatched" : "not-configured" }, { status: 201 });
  } catch (error) {
    return failure(error);
  }
}
