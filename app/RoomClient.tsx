"use client";

import { type ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import Editor, { type OnMount } from "@monaco-editor/react";
import { buildDiffLines, diffStats } from "../lib/kimi-code-diff";

type Color = "lime" | "violet" | "coral" | "sky" | "cream";
type SourcePath = string;
type RoomActionValue = string | number | boolean | null;
type ProjectKind = "game" | "app";
type WorkspaceTab = "preview" | "code" | "assets" | "forks" | "diff" | "showcase" | "activity";

type SourceFile = {
  path: SourcePath;
  content: string;
  language: "html" | "css" | "javascript" | "json" | "markdown" | "text";
  sha256: string;
  byteCount: number;
};

type Build = {
  id: string;
  version: number;
  status: string;
  name: string;
  proposalTitle: string;
  rationale: string;
  summary: string;
  changes: string[];
  sourceMessageIds: string[];
  html: string;
  sourceKind: string;
  agentLabel: string | null;
  parentBuildId: string | null;
  files: SourceFile[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
};

type ProjectAsset = {
  id: string;
  name: string;
  kind: "image" | "audio";
  contentType: string;
  byteCount: number;
  sha256: string;
  sourceAssetId: string | null;
  uploadedBy: string;
  uploadedByName: string;
  createdAt: string;
  canDelete: boolean;
};

type RoomState = {
  room: {
    id: string;
    slug: string;
    name: string;
    note: string;
    parentRoomId: string | null;
    parentRoom: { slug: string; name: string; updatedAt: string } | null;
    presentedAt: string | null;
    forkCount: number;
    canInvite: boolean;
    revision: number;
  };
  user: { id: string; displayName: string };
  rooms: Array<{ slug: string; name: string; updatedAt: string; role: string }>;
  branches: Array<{
    slug: string;
    name: string;
    updatedAt: string;
    ownerName: string;
    role: string | null;
    presentedAt: string | null;
  }>;
  showcase: Array<{
    slug: string;
    name: string;
    ownerName: string;
    presentedAt: string;
    build: Build;
  }>;
  messages: Array<{
    id: string;
    body: string;
    createdAt: string;
    authorId: string;
    authorName: string;
  }>;
  members: Array<{
    id: string;
    displayName: string;
    role: string;
    lastSeenAt: string;
    online: boolean;
  }>;
  published: Build | null;
  staged: Build | null;
  activity: Array<{
    id: string;
    version: number;
    status: string;
    title: string;
    summary: string;
    createdAt: string;
  }>;
  votes: {
    count: number;
    myVote: boolean;
    threshold: number;
    voterIds: string[];
  };
  agentTokens: Array<{
    id: string;
    name: string;
    tokenPrefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
  assets: ProjectAsset[];
  model: { configured: boolean; name: string };
};

type SourceDraft = {
  content: string;
  baseContent: string;
  baseBuildId: string;
  expectedRevision: number;
};

type EditorStatus = {
  kind: "saved" | "conflict";
  path: SourcePath;
  message: string;
} | null;

type Props = {
  initialUser: { displayName: string };
  initialSlug: string;
  signOutPath: string;
};

const colors: Color[] = ["coral", "violet", "sky", "cream", "lime"];
function getSourceFile(build: Build | null | undefined, path: SourcePath) {
  return build?.files.find((file) => file.path === path) ?? null;
}

function proposalSourceLabel(sourceKind: string) {
  if (sourceKind === "manual") return "MANUAL EDIT";
  if (sourceKind === "kimi") return "KIMI SYNTHESIS";
  if (sourceKind === "personal-agent") return "PERSONAL AGENT";
  if (sourceKind === "convergence") return "CONVERGENCE AGENT";
  if (sourceKind === "fork-merge") return "FORK CONVERGENCE";
  return sourceKind.replaceAll("-", " ").toUpperCase() || "ROOM PATCH";
}

function languageForPath(path: string): SourceFile["language"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "markdown";
  return "text";
}

function fileGlyph(language: SourceFile["language"]) {
  if (language === "css") return "#";
  if (language === "javascript") return "JS";
  if (language === "json") return "{}";
  if (language === "markdown") return "M↓";
  if (language === "html") return "<>";
  return "–";
}

function projectKindFor(build: Build | null | undefined): ProjectKind {
  const manifest = getSourceFile(build, "project.make.json");
  if (!manifest) return "app";
  try {
    const parsed = JSON.parse(manifest.content) as { kind?: unknown };
    return parsed.kind === "game" ? "game" : "app";
  } catch {
    return "app";
  }
}

function laneForPath(path: string, kind: ProjectKind) {
  if (kind === "game") {
    if (path.startsWith("assets/")) return "art";
    if (path.startsWith("audio/")) return "audio";
    if (path.startsWith("world/")) return "world";
    if (path.startsWith("playtests/")) return "playtest";
    if (path.startsWith("src/")) return "logic";
    if (path === "index.html" || path === "styles.css") return "stage";
    return "project";
  }
  if (path.startsWith("src/")) return "logic";
  if (path.startsWith("data/")) return "data";
  if (path.startsWith("tests/") || path.startsWith("docs/")) return "quality";
  if (path === "index.html" || path === "styles.css" || path.startsWith("components/")) return "interface";
  return "project";
}

function utf8ByteCount(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function fileSizeLabel(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function initials(name: string) {
  return name
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";
}

function colorFor(value: string): Color {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return colors[Math.abs(hash) % colors.length];
}

function parseTime(value: string) {
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(parseTime(value));
}

function activityTime(value: string) {
  const date = parseTime(value);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? timeLabel(value)
    : new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(date);
}

function Avatar({ id, name, small = false }: { id: string; name: string; small?: boolean }) {
  return (
    <span
      className={`avatar avatar--${colorFor(id)} ${small ? "avatar--small" : ""}`}
      title={name}
      aria-label={name}
    >
      {initials(name)}
    </span>
  );
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "The room request failed.");
  return payload;
}

export default function RoomClient({ initialUser, initialSlug, signOutPath }: Props) {
  const [state, setState] = useState<RoomState | null>(null);
  const slug = state?.room.slug ?? initialSlug;
  const [draft, setDraft] = useState("");
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("code");
  const [activeSourcePath, setActiveSourcePath] = useState<SourcePath>("index.html");
  const [activeDiffPath, setActiveDiffPath] = useState<SourcePath>("index.html");
  const [sourceDrafts, setSourceDrafts] = useState<Partial<Record<SourcePath, SourceDraft>>>({});
  const [editorStatus, setEditorStatus] = useState<EditorStatus>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Room history is saved automatically");
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [newRoomTemplate, setNewRoomTemplate] = useState<ProjectKind>("game");
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [assetKindFilter, setAssetKindFilter] = useState<"all" | "image" | "audio">("all");
  const [agentOpen, setAgentOpen] = useState(false);
  const [agentEndpoint, setAgentEndpoint] = useState(() =>
    typeof window === "undefined"
      ? "http://localhost:11434"
      : window.localStorage.getItem("make-room-agent-endpoint") ??
        "http://localhost:11434",
  );
  const [agentModel, setAgentModel] = useState(() =>
    typeof window === "undefined"
      ? "qwen3:4b"
      : window.localStorage.getItem("make-room-agent-model") ?? "qwen3:4b",
  );
  const [agentInstruction, setAgentInstruction] = useState("");
  const [gatewayOpen, setGatewayOpen] = useState(false);
  const [agentTokenName, setAgentTokenName] = useState("My coding agent");
  const [revealedAgentToken, setRevealedAgentToken] = useState<string | null>(null);
  const [siteOrigin, setSiteOrigin] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const saveSourceProposalRef = useRef<() => void>(() => undefined);
  const conversationPane = useRef<HTMLElement>(null);
  const buildPane = useRef<HTMLElement>(null);
  const assetFileInput = useRef<HTMLInputElement>(null);

  const loadRoom = useCallback(
    async (inviteToken?: string | null) => {
      const sequence = ++loadSequence.current;
      try {
        const response = inviteToken
          ? await fetch("/api/room", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "join", slug, token: inviteToken }),
            })
          : await fetch(slug ? `/api/room?slug=${encodeURIComponent(slug)}` : "/api/room", {
              headers: { accept: "application/json" },
              cache: "no-store",
            });
        const nextState = await readResponse<RoomState>(response);
        if (sequence !== loadSequence.current) return;
        setState((current) =>
          current &&
          current.room.slug === nextState.room.slug &&
          current.room.revision > nextState.room.revision
            ? current
            : nextState,
        );
        if (!slug && !inviteToken) {
          window.history.replaceState({}, "", `/?room=${encodeURIComponent(nextState.room.slug)}`);
        }
        if (inviteToken) window.history.replaceState({}, "", `/?room=${encodeURIComponent(slug)}`);
        setError(null);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "The room could not load.");
      }
    },
    [slug],
  );

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      setSiteOrigin(window.location.origin);
      const inviteToken = new URLSearchParams(window.location.hash.slice(1)).get("invite");
      void loadRoom(inviteToken);
    }, 0);
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadRoom();
    }, 2_000);
    return () => {
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [loadRoom]);

  const mutateRoom = useCallback(
    async <T,>(action: string, extra: Record<string, RoomActionValue> = {}) => {
      const response = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, slug, ...extra }),
      });
      return readResponse<T>(response);
    },
    [slug],
  );

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy("message");
    setError(null);
    try {
      const nextState = await mutateRoom<RoomState>("message", { body });
      setState(nextState);
      setDraft("");
      setNotice("Message saved · ready for collective synthesis");
    } catch (messageError) {
      setError(messageError instanceof Error ? messageError.message : "The message could not send.");
    } finally {
      setBusy(null);
    }
  }

  async function synthesizeThread() {
    if (!state?.model.configured || busy) return;
    setBusy("synthesize");
    setError(null);
    setNotice("Kimi is reading the canonical room history and synthesizing a patch…");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      setState(await readResponse<RoomState>(response));
      setActiveTab("preview");
      setNotice("A Kimi source patch is staged · review it before backing");
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Kimi could not finish the patch.",
      );
      setNotice("Nothing changed · the published build is still safe");
    } finally {
      setBusy(null);
    }
  }

  async function convergeForks() {
    if (!state?.model.configured || state.staged || state.showcase.length === 0 || busy) return;
    setBusy("converge");
    setError(null);
    setNotice(`Comparing ${state.showcase.length} presented fork${state.showcase.length === 1 ? "" : "s"} with the main project…`);
    try {
      const response = await fetch("/api/converge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const nextState = await readResponse<RoomState>(response);
      setState(nextState);
      setActiveTab("diff");
      setNotice("One convergence proposal is staged · inspect the combined files before backing");
    } catch (convergenceError) {
      setError(
        convergenceError instanceof Error
          ? convergenceError.message
          : "The presented forks could not be converged.",
      );
      setNotice("Nothing changed · every presented fork and the published parent are still safe");
    } finally {
      setBusy(null);
    }
  }

  async function vote() {
    if (!state?.staged || busy) return;
    setBusy("vote");
    setError(null);
    try {
      setState(
        await mutateRoom<RoomState>("vote", {
          expectedRevision: state.room.revision,
          buildId: state.staged.id,
        }),
      );
      setNotice(state.votes.myVote ? "Backing removed" : "Your backing is recorded");
    } catch (voteError) {
      setError(voteError instanceof Error ? voteError.message : "The vote could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function ship() {
    if (!state?.staged || busy) return;
    setBusy("ship");
    setError(null);
    try {
      setState(await mutateRoom<RoomState>("ship"));
      setNotice("The backed artifact is now the room’s published build");
    } catch (shipError) {
      setError(shipError instanceof Error ? shipError.message : "The artifact could not ship.");
    } finally {
      setBusy(null);
    }
  }

  async function fork() {
    if (!state || state.staged || busy) return;
    setBusy("fork");
    setError(null);
    try {
      const result = await mutateRoom<{ slug: string }>("fork");
      window.location.assign(`/?room=${encodeURIComponent(result.slug)}`);
    } catch (forkError) {
      setError(forkError instanceof Error ? forkError.message : "The room could not fork.");
      setBusy(null);
    }
  }

  async function mergeToParent() {
    if (!state?.room.parentRoom || state.staged || busy) return;
    setBusy("merge-parent");
    setError(null);
    setNotice("Comparing this fork with the latest parent workspace…");
    try {
      const result = await mutateRoom<{ slug: string }>("merge-parent");
      window.location.assign(`/?room=${encodeURIComponent(result.slug)}`);
    } catch (mergeError) {
      setError(
        mergeError instanceof Error
          ? mergeError.message
          : "This fork could not combine into its parent.",
      );
      setNotice("The fork is unchanged · resolve the conflict or try again");
      setBusy(null);
    }
  }

  async function presentToParent() {
    if (!state?.room.parentRoom || !state.published || state.staged || busy) return;
    setBusy("present-parent");
    setError(null);
    try {
      await mutateRoom<{ slug: string }>("present-parent");
      await loadRoom();
      setNotice("Published fork presented to the parent room · the team can compare it now");
    } catch (presentError) {
      setError(
        presentError instanceof Error
          ? presentError.message
          : "The fork could not be presented.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function makeRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newRoomName.trim() || busy) return;
    setBusy("create");
    setError(null);
    try {
      const result = await mutateRoom<{ slug: string }>("create", {
        name: newRoomName,
        template: newRoomTemplate,
      });
      window.location.assign(`/?room=${encodeURIComponent(result.slug)}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The room could not be created.");
      setBusy(null);
    }
  }

  async function makeInvite() {
    if (!state?.room.canInvite || busy) return;
    setBusy("invite");
    setError(null);
    try {
      const result = await mutateRoom<{ token: string }>("invite");
      const url = new URL(window.location.origin);
      url.searchParams.set("room", slug);
      url.hash = `invite=${encodeURIComponent(result.token)}`;
      const link = url.toString();
      setInviteLink(link);
      try {
        await navigator.clipboard.writeText(link);
        setNotice("Invite link copied · the previous invite is now replaced");
      } catch {
        setNotice("Invite created · copy it from the room banner");
      }
    } catch (inviteError) {
      setError(inviteError instanceof Error ? inviteError.message : "The invite could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function uploadAssets(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (!state || files.length === 0 || busy) return;
    setBusy("asset-upload");
    setError(null);
    try {
      let nextState = state;
      for (const file of files) {
        const form = new FormData();
        form.set("room", slug);
        form.set("file", file);
        const response = await fetch("/api/assets", { method: "POST", body: form });
        nextState = await readResponse<RoomState>(response);
      }
      setState(nextState);
      setActiveTab("assets");
      setNotice(`${files.length} shared asset${files.length === 1 ? "" : "s"} stored in the room`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "The asset could not upload.");
    } finally {
      setBusy(null);
    }
  }

  async function removeAsset(asset: ProjectAsset) {
    if (!state || !asset.canDelete || busy) return;
    setBusy(`asset-delete-${asset.id}`);
    setError(null);
    try {
      const response = await fetch("/api/assets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room: slug, assetId: asset.id }),
      });
      setState(await readResponse<RoomState>(response));
      setNotice(`${asset.name} removed from this branch`);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "The asset could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  async function createGatewayToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || busy) return;
    setBusy("create-agent-token");
    setError(null);
    try {
      const result = await mutateRoom<{ token: string; state: RoomState }>("create-agent-token", {
        name: agentTokenName,
      });
      setState(result.state);
      setRevealedAgentToken(result.token);
      setNotice("Agent key created · copy it now because it will not be shown again");
    } catch (tokenError) {
      setError(tokenError instanceof Error ? tokenError.message : "The agent key could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function revokeGatewayToken(tokenId: string) {
    if (!state || busy) return;
    setBusy(`revoke-${tokenId}`);
    setError(null);
    try {
      setState(await mutateRoom<RoomState>("revoke-agent-token", { tokenId }));
      setRevealedAgentToken(null);
      setNotice("Agent key revoked · future requests with it are blocked");
    } catch (tokenError) {
      setError(tokenError instanceof Error ? tokenError.message : "The agent key could not be revoked.");
    } finally {
      setBusy(null);
    }
  }

  function createProjectFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || !visibleBuild) return;
    const path = newFilePath.trim();
    if (
      !path ||
      path.length > 120 ||
      path.startsWith("/") ||
      path.endsWith("/") ||
      path.includes("//") ||
      !/^[A-Za-z0-9._/-]+$/.test(path) ||
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      setError("Use a safe relative path such as components/card.js or notes/idea.md.");
      return;
    }
    if (visibleBuild.files.some((file) => file.path === path)) {
      setError("That project file already exists.");
      return;
    }
    setSourceDrafts((current) => ({
      ...current,
      [path]: {
        content: "",
        baseContent: "",
        baseBuildId: visibleBuild.id,
        expectedRevision: state.room.revision,
      },
    }));
    setActiveSourcePath(path);
    setNewFilePath("");
    setNewFileOpen(false);
    setEditorStatus(null);
    setError(null);
    setNotice(`${path} is a local draft · add content, then stage it for review`);
  }

  async function runPersonalAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!state || !visibleBuild || !activeSourcePath || busy) return;
    const endpoint = agentEndpoint.trim().replace(/\/$/, "");
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(endpoint);
    } catch {
      setError("Enter a valid local Ollama address.");
      return;
    }
    if (
      endpointUrl.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(endpointUrl.hostname)
    ) {
      setError("The personal-agent MVP only connects to Ollama on this device.");
      return;
    }
    const model = agentModel.trim();
    if (!model || !agentInstruction.trim()) return;
    const agentBase = activeSourceDraft ?? {
      content: editorValue,
      baseContent: editorValue,
      baseBuildId: visibleBuild.id,
      expectedRevision: state.room.revision,
    };

    setBusy("personal-agent");
    setError(null);
    setNotice(`${model} is working privately on ${activeSourcePath}…`);
    window.localStorage.setItem("make-room-agent-endpoint", endpoint);
    window.localStorage.setItem("make-room-agent-model", model);

    try {
      const response = await fetch(`${endpoint}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          stream: false,
          options: { temperature: 0 },
          format: {
            type: "object",
            additionalProperties: false,
            properties: { content: { type: "string" } },
            required: ["content"],
          },
          messages: [
            {
              role: "system",
              content:
                "You are a personal coding agent working inside one private fork. Return JSON with exactly one field named content containing the complete replacement for the requested file. Keep the existing product direction, do not add secrets or external network calls, and return no markdown fences.",
            },
            {
              role: "user",
              content: `PROJECT: ${state.room.name}\nFILE: ${activeSourcePath}\nREQUEST: ${agentInstruction.trim()}\n\nCURRENT FILE\n${editorValue}`,
            },
          ],
        }),
      });
      const payload = (await response.json()) as {
        error?: string;
        message?: { content?: string };
      };
      if (!response.ok) throw new Error(payload.error ?? "The local model rejected the request.");
      const parsed = JSON.parse(payload.message?.content ?? "{}") as { content?: unknown };
      if (typeof parsed.content !== "string") {
        throw new Error("The local model did not return a complete file replacement.");
      }

      const roomResponse = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "agent-file",
          slug,
          path: activeSourcePath,
          content: parsed.content,
          expectedRevision: agentBase.expectedRevision,
          baseBuildId: agentBase.baseBuildId,
          agentLabel: `Local · ${model}`,
        }),
      });
      const nextState = await readResponse<RoomState>(roomResponse);
      setState(nextState);
      setSourceDrafts((current) => {
        const next = { ...current };
        delete next[activeSourcePath];
        return next;
      });
      setAgentInstruction("");
      setAgentOpen(false);
      setActiveTab("diff");
      setNotice(`${model} proposed ${activeSourcePath} · review the exact diff before backing`);
    } catch (agentError) {
      setError(
        agentError instanceof Error
          ? `${agentError.message} Ollama may need to allow this site's origin.`
          : "The personal agent could not finish the file.",
      );
      setNotice("Nothing was staged · your current project is unchanged");
    } finally {
      setBusy(null);
    }
  }

  function updateSourceDraft(content: string) {
    if (!state || !visibleBuild) return;
    const sourceFile = getSourceFile(visibleBuild, activeSourcePath);

    setSourceDrafts((current) => {
      const existing = current[activeSourcePath] ?? {
        content: sourceFile?.content ?? "",
        baseContent: sourceFile?.content ?? "",
        baseBuildId: visibleBuild.id,
        expectedRevision: state.room.revision,
      };
      const next = { ...current };

      if (sourceFile && content === existing.baseContent) {
        delete next[activeSourcePath];
      } else {
        next[activeSourcePath] = { ...existing, content };
      }

      return next;
    });
    setEditorStatus((current) =>
      current?.kind === "conflict" && current.path === activeSourcePath ? current : null,
    );
  }

  async function saveSourceProposal() {
    const sourceDraft = sourceDrafts[activeSourcePath];
    if (!state || !sourceDraft || busy) return;

    setBusy("edit-file");
    setError(null);
    setEditorStatus(null);

    try {
      const response = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "edit-file",
          slug,
          path: activeSourcePath,
          content: sourceDraft.content,
          expectedRevision: sourceDraft.expectedRevision,
          baseBuildId: sourceDraft.baseBuildId,
        }),
      });
      const payload = (await response.json()) as RoomState & { error?: string };

      if (response.status === 409) {
        setEditorStatus({
          kind: "conflict",
          path: activeSourcePath,
          message: payload.error ?? "The room changed while you were editing.",
        });
        setNotice("Your local source is safe · reload the room version or copy your draft");
        await loadRoom();
        return;
      }

      if (!response.ok) throw new Error(payload.error ?? "The source proposal could not be saved.");

      setState(payload);
      setSourceDrafts((current) => {
        const next = { ...current };
        delete next[activeSourcePath];
        return next;
      });
      setEditorStatus({
        kind: "saved",
        path: activeSourcePath,
        message: "Saved as the room’s staged proposal. Active backing was reset.",
      });
      setNotice("Source patch staged · review the diff, then gather backing");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The source proposal could not save.");
    } finally {
      setBusy(null);
    }
  }

  saveSourceProposalRef.current = () => void saveSourceProposal();

  const mountCodeEditor: OnMount = (editor, monaco) => {
    monaco.editor.defineTheme("make-room", {
      base: "vs-dark",
      inherit: true,
      rules: [
        { token: "comment", foreground: "74776f" },
        { token: "keyword", foreground: "9d8cff" },
        { token: "string", foreground: "caff45" },
        { token: "number", foreground: "ff9a7e" },
      ],
      colors: {
        "editor.background": "#0f100e",
        "editor.foreground": "#c7c9c1",
        "editorLineNumber.foreground": "#4f524b",
        "editorLineNumber.activeForeground": "#a4a69e",
        "editor.lineHighlightBackground": "#171815",
        "editor.selectionBackground": "#394321",
        "editorCursor.foreground": "#caff45",
        "editorIndentGuide.background1": "#23251f",
        "editorIndentGuide.activeBackground1": "#3a3d35",
      },
    });
    monaco.editor.setTheme("make-room");
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      saveSourceProposalRef.current();
    });
    editor.focus();
  };

  async function removeProjectFile() {
    if (
      !state ||
      !visibleBuild ||
      !activeSourceFile ||
      activeSourcePath === "index.html" ||
      activeSourcePath === "styles.css" ||
      busy
    ) {
      return;
    }
    setBusy("delete-file");
    setError(null);
    setEditorStatus(null);
    try {
      const response = await fetch("/api/room", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "delete-file",
          slug,
          path: activeSourcePath,
          expectedRevision: state.room.revision,
          baseBuildId: visibleBuild.id,
        }),
      });
      const payload = (await response.json()) as RoomState & { error?: string };
      if (response.status === 409) {
        setError(payload.error ?? "The room changed before this file could be removed.");
        await loadRoom();
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? "The file could not be removed.");
      setState(payload);
      setSourceDrafts((current) => {
        const next = { ...current };
        delete next[activeSourcePath];
        return next;
      });
      setActiveSourcePath("index.html");
      setNotice(`${activeSourcePath} removal staged · the published project is still unchanged`);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "The file could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  async function reloadLatestSource() {
    setSourceDrafts((current) => {
      const next = { ...current };
      delete next[activeSourcePath];
      return next;
    });
    setEditorStatus(null);
    await loadRoom();
    setNotice("Latest room source loaded");
  }

  const visibleBuild = state?.staged ?? state?.published;
  const projectKind = projectKindFor(visibleBuild);
  const isGameProject = projectKind === "game";
  const workspaceTabs: WorkspaceTab[] = isGameProject
    ? ["preview", "code", "assets", "forks", "diff", "showcase", "activity"]
    : ["preview", "code", "forks", "diff", "showcase", "activity"];
  const sourcePaths = Array.from(
    new Set([
      ...(visibleBuild?.files.map((file) => file.path) ?? []),
      ...Object.keys(sourceDrafts),
    ]),
  ).sort((left, right) => {
    const preferred = ["index.html", "styles.css", "src/app.js", "README.md"];
    const leftIndex = preferred.indexOf(left);
    const rightIndex = preferred.indexOf(right);
    if (leftIndex >= 0 || rightIndex >= 0) {
      return (leftIndex < 0 ? preferred.length : leftIndex) -
        (rightIndex < 0 ? preferred.length : rightIndex);
    }
    return left.localeCompare(right);
  });
  const activeSourceFile = getSourceFile(visibleBuild, activeSourcePath);
  const activeSourceDraft = sourceDrafts[activeSourcePath];
  const editorValue = activeSourceDraft?.content ?? activeSourceFile?.content ?? "";
  const editorIsDirty = Boolean(
    activeSourceDraft && activeSourceDraft.content !== activeSourceDraft.baseContent,
  );
  const editorIsStale = Boolean(
    state &&
      activeSourceDraft &&
      (activeSourceDraft.expectedRevision !== state.room.revision ||
        activeSourceDraft.baseBuildId !== visibleBuild?.id),
  );
  const diffByPath = (() => {
    const result = {} as Record<
      SourcePath,
      { rows: ReturnType<typeof buildDiffLines>; added: number; removed: number }
    >;

    for (const path of sourcePaths) {
      const before = getSourceFile(state?.published, path)?.content ?? "";
      const after = getSourceFile(state?.staged, path)?.content ?? before;
      const rows = state?.staged ? buildDiffLines(before, after) : [];
      const stats = rows ? diffStats(rows) : { added: 0, removed: 0 };
      result[path] = { rows, ...stats };
    }

    return result;
  })();
  const activeDiff = diffByPath[activeDiffPath] ?? { rows: [], added: 0, removed: 0 };
  const voterMembers = useMemo(
    () =>
      state?.members.filter((member) => state.votes.voterIds.includes(member.id)) ?? [],
    [state],
  );
  const onlineMembers =
    state?.members.filter((member) => member.online) ?? [];
  const currentUserName = state?.user.displayName ?? initialUser.displayName;
  const visibleAssets = state?.assets.filter(
    (asset) => assetKindFilter === "all" || asset.kind === assetKindFilter,
  ) ?? [];

  function openProjectLane(path: string) {
    if (path === "__play__") {
      setActiveTab("preview");
      return;
    }
    if (path === "__assets_image__" || path === "__assets_audio__") {
      setAssetKindFilter(path.endsWith("image__") ? "image" : "audio");
      setActiveTab("assets");
      return;
    }
    if (!sourcePaths.includes(path)) return;
    setActiveSourcePath(path);
    setActiveTab("code");
  }

  return (
    <main className="product-shell">
      <div className="workspace">
        <aside className="room-rail" aria-label="Your rooms">
          <div className="rail-brand">
            <Link className="wordmark" href="/" aria-label="Make Room home">
              <span className="wordmark__spark">✳</span>
              <span>make/room</span>
            </Link>
            <span className="rail-brand__mode">{isGameProject ? "GAME STUDIO" : "OPEN STUDIO"}</span>
          </div>

          <div className="rail-section-label">
            <span>your rooms</span>
            <button
              type="button"
              aria-label="Create a room"
              aria-expanded={newRoomOpen}
              onClick={() => setNewRoomOpen((current) => !current)}
            >
              +
            </button>
          </div>

          {newRoomOpen && (
            <form className="new-room-form" onSubmit={makeRoom}>
              <label htmlFor="new-room-name">Room name</label>
              <input
                id="new-room-name"
                value={newRoomName}
                onChange={(event) => setNewRoomName(event.target.value)}
                placeholder="new room"
                maxLength={50}
                autoFocus
              />
              <div className="project-template-picker" role="group" aria-label="Starting project">
                <button
                  type="button"
                  className={newRoomTemplate === "game" ? "is-active" : ""}
                  aria-pressed={newRoomTemplate === "game"}
                  onClick={() => setNewRoomTemplate("game")}
                >
                  <span>GAME</span>
                  <small>playable 2D starter</small>
                </button>
                <button
                  type="button"
                  className={newRoomTemplate === "app" ? "is-active" : ""}
                  aria-pressed={newRoomTemplate === "app"}
                  onClick={() => setNewRoomTemplate("app")}
                >
                  <span>APP</span>
                  <small>open web workspace</small>
                </button>
              </div>
              <button type="submit" disabled={!newRoomName.trim() || Boolean(busy)}>
                create {newRoomTemplate} →
              </button>
            </form>
          )}

          <nav className="room-list">
            {state?.rooms.map((room) => (
              <Link
                className={`room-link ${room.slug === state.room.slug ? "is-active" : ""}`}
                href={`/?room=${encodeURIComponent(room.slug)}`}
                key={room.slug}
              >
                <span className="room-link__symbol">{room.role === "owner" ? "✦" : "◌"}</span>
                <span className="room-link__copy">
                  <strong>{room.name}</strong>
                  <small>{room.role}</small>
                </span>
              </Link>
            ))}
          </nav>

          {state && (state.room.parentRoom || state.branches.length > 0) && (
            <section className="branch-map" aria-label="Fork lineage">
              {state.room.parentRoom && (
                <div className="branch-map__current">
                  <span>WORKING BRANCH</span>
                  <strong>{state.room.name}</strong>
                  <Link href={`/?room=${encodeURIComponent(state.room.parentRoom.slug)}`}>
                    ↖ parent · {state.room.parentRoom.name}
                  </Link>
                  <button
                    className="branch-map__present"
                    type="button"
                    onClick={presentToParent}
                    disabled={Boolean(busy) || !state.published || Boolean(state.staged)}
                    title={state.staged ? "Ship the fork proposal before presenting it" : undefined}
                  >
                    {busy === "present-parent"
                      ? "presenting…"
                      : state.room.presentedAt
                        ? "refresh presentation ◫"
                        : "present fork ◫"}
                  </button>
                  <button
                    type="button"
                    onClick={mergeToParent}
                    disabled={Boolean(busy) || !state.published || Boolean(state.staged)}
                    title={state.staged ? "Ship the fork proposal before merging it" : undefined}
                  >
                    {busy === "merge-parent" ? "combining…" : "propose merge ↗"}
                  </button>
                </div>
              )}
              {state.branches.length > 0 && (
                <div className="branch-map__children">
                  <span>TEAM FORKS</span>
                  {state.branches.slice(0, 4).map((branch) =>
                    branch.role ? (
                      <Link
                        href={`/?room=${encodeURIComponent(branch.slug)}`}
                        title={branch.name}
                        key={branch.slug}
                      >
                        <i />
                        <strong>{branch.ownerName}&apos;s fork</strong>
                        <small>{branch.presentedAt ? "presenting ◫" : "open →"}</small>
                      </Link>
                    ) : (
                      <div className="branch-map__private" title={branch.name} key={branch.slug}>
                        <i />
                        <strong>{branch.ownerName}&apos;s fork</strong>
                        <small>{branch.presentedAt ? "presenting ◫" : "working"}</small>
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>
          )}

          <div className="rail-callout">
            <span className="rail-callout__eyebrow">ROOM RECORD</span>
            <p>
              {state
                ? `${state.messages.length} messages · ${state.activity.length} builds · ${state.members.length} makers`
                : "Loading the durable room history…"}
            </p>
            <span className="rail-callout__foot">Saved in the shared room, not this device.</span>
          </div>

          <div className="presence-panel">
            <div className="presence-stack">
              {onlineMembers.slice(0, 5).map((member) => (
                <Avatar id={member.id} name={member.displayName} small key={member.id} />
              ))}
            </div>
            <p>
              <strong>{onlineMembers.length} here now</strong>
              <span>{state?.members.length ?? 0} room members</span>
            </p>
          </div>
        </aside>

        <section ref={conversationPane} className="conversation" aria-label="Room conversation">
          <div className="conversation__header">
            <div className="conversation__context">
              <div className="conversation__title">
                <span className="live-dot" aria-label="Room sync is active" />
                <strong>{state?.room.name ?? "loading room"}</strong>
              </div>
              <p>{state?.room.note ?? "Opening the room…"}</p>
            </div>
            <div className="conversation__actions">
              <button
                className="mobile-pane-switch"
                type="button"
                onClick={() =>
                  buildPane.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "nearest",
                    inline: "start",
                  })
                }
              >
                workspace →
              </button>
              <span className={`engine-pill ${state && !state.model.configured ? "engine-pill--blocked" : ""}`}>
                <span className="engine-pill__dot" />
                {state?.model.configured ? state.model.name : "K3 key needed"}
              </span>
              {state?.room.canInvite && (
                <button className="quiet-button" type="button" onClick={makeInvite} disabled={Boolean(busy)}>
                  {busy === "invite" ? "creating…" : "invite"}
                </button>
              )}
              <a
                className={`avatar avatar--${colorFor(state?.user.id ?? currentUserName)} avatar--you`}
                href={signOutPath}
                title={`Sign out ${currentUserName}`}
                aria-label={`Sign out ${currentUserName}`}
              >
                {initials(currentUserName)}
              </a>
            </div>
          </div>

          <div className="room-note">
            <span>{isGameProject ? "STUDIO LOOP" : "ROOM RULES"}</span>
            <p>
              {isGameProject
                ? "Play → fork → build by lane → present → converge. Every shipped version stays playable."
                : "Thread → patch → review → majority ship. Published builds never change silently."}
            </p>
          </div>

          {inviteLink && (
            <div className="invite-banner">
              <span>INVITE READY</span>
              <input value={inviteLink} readOnly aria-label="Room invite link" onFocus={(event) => event.currentTarget.select()} />
              <button type="button" onClick={() => setInviteLink(null)} aria-label="Hide invite link">×</button>
            </div>
          )}

          {error && (
            <div className="error-banner" role="alert">
              <span>!</span>
              <p>{error}</p>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}

          <div className="message-list" aria-live="polite">
            {!state && (
              <div className="empty-room">
                <span>SYNCING</span>
                <p>Loading the real room history…</p>
              </div>
            )}
            {state && state.messages.length === 0 && (
              <div className="empty-room">
                <span>THE ROOM IS QUIET</span>
                <p>Start with a need, a constraint, or the smallest thing worth making.</p>
              </div>
            )}
            {state?.messages.map((message) => (
              <article className="message" key={message.id}>
                <Avatar id={message.authorId} name={message.authorName} />
                <div className="message__body">
                  <div className="message__meta">
                    <strong>{message.authorName}</strong>
                    <time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time>
                  </div>
                  <p>{message.body}</p>
                </div>
              </article>
            ))}
          </div>

          {state?.staged && (
            <article className="proposal-card">
              <div className="proposal-card__topline">
                <span>
                  {proposalSourceLabel(state.staged.sourceKind)} PROPOSAL · PATCH {state.staged.version}
                </span>
                <span>
                  {state.votes.count}/{state.votes.threshold} needed
                </span>
              </div>
              <h2>{state.staged.proposalTitle}</h2>
              <p>{state.staged.rationale}</p>
              <ul>
                {state.staged.changes.map((change) => (
                  <li key={change}>
                    <span>+</span>
                    {change}
                  </li>
                ))}
              </ul>
              <div className="proposal-card__actions">
                <button
                  className="diff-button"
                  type="button"
                  onClick={() => {
                    setActiveDiffPath(
                      sourcePaths.find(
                        (path) => diffByPath[path].added > 0 || diffByPath[path].removed > 0,
                      ) ?? "index.html",
                    );
                    setActiveTab("diff");
                    document.querySelector(".build-panel")?.scrollIntoView({ behavior: "smooth" });
                  }}
                >
                  view diff
                </button>
                <div className="micro-stack" aria-label={`${state.votes.count} recorded votes`}>
                  {voterMembers.map((member) => (
                    <Avatar id={member.id} name={member.displayName} small key={member.id} />
                  ))}
                </div>
                <button
                  className={`vote-button ${state.votes.myVote ? "is-backed" : ""}`}
                  type="button"
                  onClick={vote}
                  disabled={Boolean(busy)}
                >
                  {busy === "vote" ? "saving…" : state.votes.myVote ? "backed ✓" : "back this"}
                </button>
                <button
                  className="ship-button"
                  type="button"
                  onClick={ship}
                  disabled={Boolean(busy) || state.votes.count < state.votes.threshold}
                  title={
                    state.votes.count < state.votes.threshold
                      ? `${state.votes.threshold - state.votes.count} more backing vote needed`
                      : "Publish this backed artifact"
                  }
                >
                  {busy === "ship" ? "shipping…" : "ship to room →"}
                </button>
              </div>
            </article>
          )}

          <div className="composer-wrap">
            {!state?.model.configured && (
              <div className="model-blocker">
                <strong>Live Kimi synthesis is locked.</strong>
                <span>Add the server-side MOONSHOT_API_KEY secret—there is no demo fallback.</span>
              </div>
            )}
            <div className="synthesis-line">
              <span>{notice}</span>
              <button
                type="button"
                onClick={synthesizeThread}
                disabled={Boolean(busy) || !state?.model.configured || !state.messages.length}
              >
                {busy === "synthesize" ? "synthesizing patch…" : "synthesize patch ✳"}
              </button>
            </div>
            <form className="composer" onSubmit={submitMessage}>
              <label htmlFor="room-message">Add to the room</label>
              <textarea
                id="room-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Add an idea, a constraint, or a weird thought…"
                rows={2}
                maxLength={1200}
              />
              <button type="submit" disabled={!draft.trim() || Boolean(busy)} aria-label="Send message">
                ↑
              </button>
            </form>
            <p className="composer-hint">↵ SEND · SHIFT ↵ NEW LINE · SIGNED IN AS {currentUserName.toUpperCase()}</p>
          </div>
        </section>

        <aside ref={buildPane} className="build-panel" aria-label="Generated app">
          <div className="build-panel__header">
            <div className="build-panel__title">
              <p className="section-kicker">{isGameProject ? "GAME STUDIO · PLAYABLE BUILD" : "OPEN STUDIO · APPLICATION"}</p>
              <h2>{visibleBuild?.name ?? "No build yet"}</h2>
            </div>
            <div className="build-panel__actions">
              <button
                className="mobile-pane-switch"
                type="button"
                onClick={() =>
                  conversationPane.current?.scrollIntoView({
                    behavior: "smooth",
                    block: "nearest",
                    inline: "start",
                  })
                }
              >
                ← thread
              </button>
              <div className="version-chip">
                <span className={state?.staged ? "status-dot status-dot--staged" : "status-dot"} />
                {state?.staged
                  ? `staging v${state.staged.version}`
                  : state?.published
                    ? `live · v${state.published.version}`
                    : "waiting"}
              </div>
              <a
                className="quiet-button export-link"
                href={state ? `/api/export?room=${encodeURIComponent(slug)}&status=${state.staged ? "staged" : "published"}` : undefined}
                aria-disabled={!state || (!state.staged && !state.published)}
                title="Download a Git-ready project with a zero-dependency local runner"
              >
                export ↓
              </a>
              <button
                className="quiet-button"
                type="button"
                onClick={() => setGatewayOpen((current) => !current)}
                aria-expanded={gatewayOpen}
              >
                agent bridge
              </button>
              {Boolean(state?.showcase.length) && (
                <button
                  className="quiet-button converge-button"
                  type="button"
                  onClick={() => void convergeForks()}
                  disabled={!state?.model.configured || Boolean(state?.staged) || Boolean(busy)}
                  title={
                    !state?.model.configured
                      ? "Configure the room model before convergence"
                      : state?.staged
                        ? "Ship or replace the current proposal first"
                        : "Compare every presented fork and stage one combined proposal"
                  }
                >
                  {busy === "converge" ? "converging…" : `converge · ${state?.showcase.length ?? 0}`}
                </button>
              )}
              <button
                className="quiet-button"
                type="button"
                onClick={fork}
                disabled={!state || Boolean(busy) || Boolean(state?.staged)}
                title={state?.staged ? "Ship the staged proposal before branching again" : undefined}
              >
                {busy === "fork" ? "forking…" : `fork · ${state?.room.forkCount ?? 0}`}
              </button>
            </div>
          </div>

          {gatewayOpen && state && (
            <section className="agent-gateway" aria-label="Personal agent gateway">
              <div className="agent-gateway__intro">
                <div>
                  <span>YOUR AGENT BRIDGE</span>
                  <h3>Give any coding agent the whole folder.</h3>
                </div>
                <p>
                  ChatGPT, Codex, Claude, Venice, or a local model can read the same canonical snapshot and submit one multi-file proposal. Every proposal still waits for room review.
                </p>
              </div>
              <div className="agent-gateway__grid">
                <form onSubmit={createGatewayToken}>
                  <label htmlFor="agent-token-name">Connection name</label>
                  <div>
                    <input
                      id="agent-token-name"
                      value={agentTokenName}
                      onChange={(event) => setAgentTokenName(event.target.value)}
                      maxLength={50}
                      placeholder="Claude on my laptop"
                    />
                    <button type="submit" disabled={!agentTokenName.trim() || Boolean(busy)}>
                      {busy === "create-agent-token" ? "creating…" : "create key"}
                    </button>
                  </div>
                  <small>Stored as a one-way hash. The full key appears once.</small>
                </form>
                <div className="agent-gateway__endpoints">
                  <span>MCP ENDPOINT</span>
                  <code>{siteOrigin ? `${siteOrigin}/api/mcp` : "/api/mcp"}</code>
                  <span>REST PROJECT ENDPOINT</span>
                  <code>{siteOrigin ? `${siteOrigin}/api/agent?room=${slug}` : `/api/agent?room=${slug}`}</code>
                </div>
              </div>
              {revealedAgentToken && (
                <div className="agent-gateway__secret" role="status">
                  <span>COPY NOW · SHOWN ONCE</span>
                  <input
                    value={revealedAgentToken}
                    readOnly
                    aria-label="New personal agent bearer token"
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button
                    type="button"
                    onClick={async () => {
                      await navigator.clipboard.writeText(revealedAgentToken);
                      setNotice("Agent key copied");
                    }}
                  >
                    copy
                  </button>
                </div>
              )}
              <div className="agent-gateway__keys">
                <div className="agent-gateway__keys-head">
                  <span>PERSONAL KEYS</span>
                  <small>Authorization: Bearer YOUR_KEY</small>
                </div>
                {state.agentTokens.length === 0 && <p>No keys yet. Create one for the agent on your device.</p>}
                {state.agentTokens.map((token) => (
                  <div className={token.revokedAt ? "is-revoked" : ""} key={token.id}>
                    <strong>{token.name}</strong>
                    <code>{token.tokenPrefix}</code>
                    <small>{token.revokedAt ? "revoked" : token.lastUsedAt ? `used ${activityTime(token.lastUsedAt)}` : "never used"}</small>
                    {!token.revokedAt && (
                      <button type="button" onClick={() => void revokeGatewayToken(token.id)} disabled={Boolean(busy)}>
                        revoke
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <p className="agent-gateway__foot">
                Connected agents also receive <strong>get_convergence_context</strong> and <strong>submit_convergence_patch</strong>, so your own AI can serve as the main-room convergence agent even when the shared Kimi button is not configured. {" "}
                Hosted provider secrets stay with that agent or in its own server environment; they are never placed in this browser or shared room.
                Because this prototype is owner-only, a remote hosted agent also needs the site owner&apos;s private Sites access header; local agents and project exports do not.
              </p>
            </section>
          )}

          {isGameProject && visibleBuild && (
            <nav className="studio-lanes" aria-label="Game production lanes">
              <span>WORK LANES</span>
              {[
                ["play", "__play__", "▶"],
                ["logic", "src/app.js", "JS"],
                ["world", "world/level-01.json", "{}"],
                ["art", "__assets_image__", "▧"],
                ["audio", "__assets_audio__", "♪"],
                ["test", "playtests/README.md", "✓"],
              ].map(([label, path, glyph]) => (
                <button
                  type="button"
                  className={
                    (path === "__play__" && activeTab === "preview") ||
                    (path === "__assets_image__" && activeTab === "assets" && assetKindFilter === "image") ||
                    (path === "__assets_audio__" && activeTab === "assets" && assetKindFilter === "audio") ||
                    (!path.startsWith("__") && activeTab === "code" && activeSourcePath === path)
                      ? "is-active"
                      : ""
                  }
                  onClick={() => openProjectLane(path)}
                  key={path}
                >
                  <i>{glyph}</i>
                  <span>{label}</span>
                </button>
              ))}
              <small>Each lane can fork, work independently, and return as one playable proposal.</small>
            </nav>
          )}

          <div className="build-tabs" role="tablist" aria-label="Build views">
            {workspaceTabs.map((tabName) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tabName}
                className={activeTab === tabName ? "is-active" : ""}
                onClick={() => setActiveTab(tabName)}
                disabled={
                  (tabName === "diff" && !state?.staged) ||
                  (tabName === "showcase" && !state?.showcase.length)
                }
                title={
                  tabName === "diff" && !state?.staged
                    ? "Stage a source patch to compare it"
                    : tabName === "showcase" && !state?.showcase.length
                      ? "A fork owner must present a published branch first"
                      : undefined
                }
                key={tabName}
              >
                {isGameProject && tabName === "preview" ? "play" : tabName}
              </button>
            ))}
            <span className="sandbox-label"><i /> isolated JS · no network</span>
          </div>

          <div
            className={`build-stage ${activeTab === "code" || activeTab === "diff" ? "build-stage--ide" : ""}`}
          >
            {state?.staged && activeTab !== "activity" && activeTab !== "showcase" && (
              <div className="staged-banner">
                <span>{proposalSourceLabel(state.staged.sourceKind)} · STAGED, NOT PUBLISHED</span>
                <span>
                  {state.staged.sourceKind === "manual"
                    ? "room source edit"
                    : state.staged.sourceKind === "personal-agent"
                      ? state.staged.agentLabel ?? "personal agent"
                    : state.staged.sourceKind === "convergence"
                      ? `${state.showcase.length} presented team forks`
                    : state.staged.sourceKind === "fork-merge"
                      ? "converged fork snapshot"
                      : `${state.staged.sourceMessageIds.length} source messages`}
                </span>
              </div>
            )}
            {activeTab === "preview" && visibleBuild && (
              <iframe
                key={visibleBuild.id}
                className="artifact-frame"
                title={`${visibleBuild.name} interactive preview`}
                srcDoc={visibleBuild.html}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            )}
            {activeTab === "assets" && state && (
              <section className="asset-library" aria-label="Shared project assets">
                <header className="asset-library__header">
                  <div>
                    <span>SHARED ASSET STORE</span>
                    <h3>Art and audio that travel with the project</h3>
                    <p>Forks inherit these references. New fork assets return to the parent when that fork is merged.</p>
                  </div>
                  <div className="asset-library__actions">
                    <div className="asset-filters" role="group" aria-label="Filter assets">
                      {(["all", "image", "audio"] as const).map((kind) => (
                        <button
                          type="button"
                          className={assetKindFilter === kind ? "is-active" : ""}
                          onClick={() => setAssetKindFilter(kind)}
                          aria-pressed={assetKindFilter === kind}
                          key={kind}
                        >
                          {kind}
                        </button>
                      ))}
                    </div>
                    <input
                      ref={assetFileInput}
                      className="asset-file-input"
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,audio/mpeg,audio/ogg,audio/wav,audio/x-wav,audio/mp4"
                      multiple
                      onChange={(event) => void uploadAssets(event)}
                      aria-label="Upload game assets"
                    />
                    <button
                      className="asset-upload-button"
                      type="button"
                      onClick={() => assetFileInput.current?.click()}
                      disabled={Boolean(busy)}
                    >
                      {busy === "asset-upload" ? "uploading…" : "upload assets +"}
                    </button>
                  </div>
                </header>

                {visibleAssets.length > 0 ? (
                  <div className="asset-grid">
                    {visibleAssets.map((asset) => {
                      const assetUrl = `/api/assets?room=${encodeURIComponent(slug)}&asset=${encodeURIComponent(asset.id)}`;
                      return (
                        <article className="asset-card" key={asset.id}>
                          <div className={`asset-card__preview asset-card__preview--${asset.kind}`}>
                            {asset.kind === "image" ? (
                              <img src={assetUrl} alt={asset.name} loading="lazy" />
                            ) : (
                              <div>
                                <span>♪</span>
                                <audio controls preload="metadata" src={assetUrl}>
                                  Your browser does not support audio previews.
                                </audio>
                              </div>
                            )}
                          </div>
                          <div className="asset-card__body">
                            <span>{asset.sourceAssetId ? "INHERITED REFERENCE" : `${asset.kind.toUpperCase()} ASSET`}</span>
                            <strong title={asset.name}>{asset.name}</strong>
                            <small>{fileSizeLabel(asset.byteCount)} · {asset.uploadedByName}</small>
                          </div>
                          <div className="asset-card__actions">
                            <a href={`${assetUrl}&download=1`}>download</a>
                            {asset.canDelete && (
                              <button
                                type="button"
                                onClick={() => void removeAsset(asset)}
                                disabled={Boolean(busy)}
                              >
                                {busy === `asset-delete-${asset.id}` ? "removing…" : "remove"}
                              </button>
                            )}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <div className="asset-empty">
                    <span>▧</span>
                    <h3>No {assetKindFilter === "all" ? "assets" : `${assetKindFilter} assets`} in this branch yet</h3>
                    <p>Upload PNG, JPEG, WebP, GIF, MP3, OGG, WAV, or M4A files up to 5 MB each.</p>
                    <button type="button" onClick={() => assetFileInput.current?.click()} disabled={Boolean(busy)}>
                      choose files →
                    </button>
                  </div>
                )}
              </section>
            )}
            {activeTab === "code" && visibleBuild && (
              <div className="source-workspace">
                <aside className="source-files" aria-label="Artifact source files">
                  <div className="source-files__heading">
                    <span>SOURCE</span>
                    <small>{sourcePaths.length} files</small>
                    <button
                      type="button"
                      onClick={() => setNewFileOpen((current) => !current)}
                      aria-expanded={newFileOpen}
                    >
                      + file
                    </button>
                  </div>
                  {newFileOpen && (
                    <form className="new-file-form" onSubmit={createProjectFile}>
                      <label htmlFor="new-file-path">Relative file path</label>
                      <input
                        id="new-file-path"
                        value={newFilePath}
                        onChange={(event) => setNewFilePath(event.target.value)}
                        placeholder="components/card.js"
                        maxLength={120}
                        autoFocus
                      />
                      <button type="submit" disabled={!newFilePath.trim()}>
                        create →
                      </button>
                    </form>
                  )}
                  {sourcePaths.map((path) => {
                    const file = getSourceFile(visibleBuild, path);
                    const fileDraft = sourceDrafts[path];
                    const language = file?.language ?? languageForPath(path);
                    const isDirty = Boolean(fileDraft && fileDraft.content !== fileDraft.baseContent);
                    return (
                      <button
                        className={`${activeSourcePath === path ? "is-active" : ""} ${isDirty ? "is-dirty" : ""}`}
                        type="button"
                        onClick={() => setActiveSourcePath(path)}
                        aria-current={activeSourcePath === path ? "page" : undefined}
                        key={path}
                      >
                        <span className={`file-glyph file-glyph--${language}`}>
                          {fileGlyph(language)}
                        </span>
                        <span>
                          <strong>{path}</strong>
                          <small>
                            {file
                              ? `${laneForPath(path, projectKind)} · ${file.byteCount.toLocaleString()} bytes`
                              : `${laneForPath(path, projectKind)} · ${utf8ByteCount(fileDraft?.content ?? "").toLocaleString()} bytes · new`}
                          </small>
                        </span>
                        {isDirty && <i aria-label="Unsaved local changes" />}
                      </button>
                    );
                  })}
                  <p>Every save becomes a reviewable room proposal.</p>
                </aside>

                <section className="source-editor" aria-label={`${activeSourcePath} editor`}>
                  <div className="source-editor__toolbar">
                    <div className="source-breadcrumb">
                      <span>artifact</span>
                      <span>/</span>
                      <strong>{activeSourcePath}</strong>
                    </div>
                    <div className="source-editor__meta">
                      {editorIsStale && <span className="source-state source-state--stale">room moved</span>}
                      {editorIsDirty && <span className="source-state source-state--dirty">local draft</span>}
                      <span>r{activeSourceDraft?.expectedRevision ?? state?.room.revision ?? 0}</span>
                      <button
                        type="button"
                        className="personal-agent-toggle"
                        onClick={() => setAgentOpen((current) => !current)}
                        aria-expanded={agentOpen}
                      >
                        my AI ✳
                      </button>
                      {activeSourceFile &&
                        activeSourcePath !== "index.html" &&
                        activeSourcePath !== "styles.css" && (
                          <button
                            type="button"
                            className="source-remove-button"
                            onClick={() => void removeProjectFile()}
                            disabled={Boolean(busy)}
                            title={`Stage removal of ${activeSourcePath}`}
                          >
                            remove
                          </button>
                        )}
                    </div>
                  </div>

                  {editorStatus?.path === activeSourcePath && (
                    <div
                      className={`source-editor__notice source-editor__notice--${editorStatus.kind}`}
                      role={editorStatus.kind === "conflict" ? "alert" : "status"}
                    >
                      <span>{editorStatus.kind === "conflict" ? "CONFLICT" : "SAVED"}</span>
                      <p>{editorStatus.message}</p>
                      {editorStatus.kind === "conflict" && (
                        <button type="button" onClick={() => void reloadLatestSource()}>
                          reload latest
                        </button>
                      )}
                    </div>
                  )}

                  {agentOpen && (
                    <form className="personal-agent" onSubmit={runPersonalAgent}>
                      <div className="personal-agent__heading">
                        <span>PERSONAL AGENT · RUNS ON YOUR DEVICE</span>
                        <strong>Ask local Ollama to propose this file</strong>
                      </div>
                      <label>
                        <span>Endpoint</span>
                        <input
                          value={agentEndpoint}
                          onChange={(event) => setAgentEndpoint(event.target.value)}
                          inputMode="url"
                          placeholder="http://localhost:11434"
                        />
                      </label>
                      <label>
                        <span>Model</span>
                        <input
                          value={agentModel}
                          onChange={(event) => setAgentModel(event.target.value)}
                          placeholder="qwen3:4b"
                        />
                      </label>
                      <label className="personal-agent__request">
                        <span>What should your agent do?</span>
                        <textarea
                          value={agentInstruction}
                          onChange={(event) => setAgentInstruction(event.target.value)}
                          placeholder={`Improve ${activeSourcePath} while preserving the room's direction…`}
                          maxLength={1200}
                          rows={3}
                        />
                      </label>
                      <p>
                        The request goes directly from this browser to your local model. Only its completed file proposal is sent to the room for review.
                      </p>
                      <button
                        type="submit"
                        disabled={!agentInstruction.trim() || !agentModel.trim() || Boolean(busy)}
                      >
                        {busy === "personal-agent" ? "agent working…" : "propose with my AI →"}
                      </button>
                    </form>
                  )}

                  <div className="source-editor__input" aria-label={`Source for ${activeSourcePath}`}>
                    <Editor
                      height="100%"
                      path={`file:///artifact/${activeSourcePath}`}
                      language={activeSourceFile?.language === "text" ? "plaintext" : activeSourceFile?.language}
                      theme="make-room"
                      value={editorValue}
                      onChange={(value) => {
                        if ((value?.length ?? 0) <= 65_536) updateSourceDraft(value ?? "");
                      }}
                      onMount={mountCodeEditor}
                      loading={<div className="monaco-loading">Opening editor…</div>}
                      options={{
                        ariaLabel: `Source for ${activeSourcePath}`,
                        automaticLayout: true,
                        bracketPairColorization: { enabled: true },
                        fontFamily: "var(--font-code)",
                        fontSize: 13,
                        lineHeight: 21,
                        minimap: { enabled: false },
                        padding: { top: 12, bottom: 16 },
                        renderLineHighlight: "all",
                        scrollBeyondLastLine: false,
                        smoothScrolling: true,
                        tabSize: 2,
                        wordWrap: "off",
                      }}
                    />
                  </div>

                  <div className="source-editor__footer">
                    <div>
                      <span className={editorIsDirty ? "editor-dirty-dot" : "editor-saved-dot"} />
                      <p>
                        <strong>{editorIsDirty ? "Local changes not staged" : "Room source in sync"}</strong>
                        <span>{utf8ByteCount(editorValue).toLocaleString()} bytes · ⌘/Ctrl+S to stage</span>
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => void saveSourceProposal()}
                      disabled={!editorIsDirty || Boolean(busy)}
                    >
                      {busy === "edit-file" ? "saving…" : "save as proposal →"}
                    </button>
                  </div>
                </section>
              </div>
            )}
            {activeTab === "forks" && state && (
              <div className="fork-workspace">
                <header className="fork-workspace__header">
                  <div>
                    <span>PROJECT LINEAGE</span>
                    <h3>Parallel work, one visible family tree</h3>
                    <p>Open a branch, build independently, present it, then converge the strongest work.</p>
                  </div>
                  <div className="fork-workspace__stats" aria-label="Fork statistics">
                    <span><strong>{state.branches.length}</strong> child forks</span>
                    <span><strong>{state.showcase.length}</strong> presented</span>
                    <span><strong>r{state.room.revision}</strong> room revision</span>
                  </div>
                </header>

                <div className="fork-flow" aria-label="Parent and child branch map">
                  <section className="fork-flow__level fork-flow__level--parent">
                    <span className="fork-flow__level-label">PARENT</span>
                    {state.room.parentRoom ? (
                      <Link
                        className="fork-node fork-node--parent"
                        href={`/?room=${encodeURIComponent(state.room.parentRoom.slug)}`}
                      >
                        <span className="fork-node__icon">↖</span>
                        <div>
                          <small>UPSTREAM ROOM</small>
                          <strong>{state.room.parentRoom.name}</strong>
                          <p>Updated {activityTime(state.room.parentRoom.updatedAt)}</p>
                        </div>
                        <b>open →</b>
                      </Link>
                    ) : (
                      <div className="fork-node fork-node--root">
                        <span className="fork-node__icon">✳</span>
                        <div>
                          <small>SHARED ROOT</small>
                          <strong>This room begins the project</strong>
                          <p>Every team fork branches from this lineage.</p>
                        </div>
                        <b>origin</b>
                      </div>
                    )}
                  </section>

                  <span className="fork-flow__connector" aria-hidden="true" />

                  <section className="fork-flow__level fork-flow__level--current">
                    <span className="fork-flow__level-label">CURRENT</span>
                    <article className="fork-node fork-node--current">
                      <span className="fork-node__icon">◆</span>
                      <div>
                        <small>{state.room.parentRoom ? "WORKING FORK" : "UNIFIED ROOM"}</small>
                        <strong>{state.room.name}</strong>
                        <p>
                          {state.messages.length} messages · {state.members.length} makers · {state.published ? `live v${state.published.version}` : "not published"}
                        </p>
                      </div>
                      <b>you are here</b>
                    </article>
                    {state.room.parentRoom && (
                      <div className="fork-flow__actions">
                        <button
                          type="button"
                          onClick={presentToParent}
                          disabled={Boolean(busy) || !state.published || Boolean(state.staged)}
                        >
                          {busy === "present-parent" ? "presenting…" : state.room.presentedAt ? "refresh presentation" : "present to parent"}
                        </button>
                        <button
                          type="button"
                          onClick={mergeToParent}
                          disabled={Boolean(busy) || !state.published || Boolean(state.staged)}
                        >
                          {busy === "merge-parent" ? "combining…" : "propose merge"}
                        </button>
                      </div>
                    )}
                  </section>

                  <span className="fork-flow__connector fork-flow__connector--split" aria-hidden="true" />

                  <section className="fork-flow__level fork-flow__level--children">
                    <span className="fork-flow__level-label">CHILD FORKS</span>
                    {state.branches.length > 0 ? (
                      <div className="fork-children">
                        {state.branches.map((branch) => {
                          const branchContent = (
                            <>
                              <span className="fork-node__icon">⑂</span>
                              <div>
                                <small>{branch.presentedAt ? "PRESENTED FOR REVIEW" : "BUILDING IN PARALLEL"}</small>
                                <strong>{branch.name}</strong>
                                <p>{branch.ownerName} · updated {activityTime(branch.updatedAt)}</p>
                              </div>
                              <b>{branch.role ? "open →" : "private"}</b>
                            </>
                          );
                          return branch.role ? (
                            <Link
                              className={`fork-node fork-node--child ${branch.presentedAt ? "is-presented" : ""}`}
                              href={`/?room=${encodeURIComponent(branch.slug)}`}
                              key={branch.slug}
                            >
                              {branchContent}
                            </Link>
                          ) : (
                            <div
                              className={`fork-node fork-node--child fork-node--locked ${branch.presentedAt ? "is-presented" : ""}`}
                              title="This branch is visible in the lineage but private to its owner"
                              key={branch.slug}
                            >
                              {branchContent}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="fork-empty">
                        <strong>No child forks yet</strong>
                        <p>Use “fork this app” to split off, work independently, and return with a proposal.</p>
                        <button type="button" onClick={fork} disabled={!state.published || Boolean(busy) || Boolean(state.staged)}>
                          {busy === "fork" ? "forking…" : "create the first fork →"}
                        </button>
                      </div>
                    )}
                  </section>
                </div>
              </div>
            )}
            {activeTab === "diff" && state?.staged && (
              <div className="diff-workspace">
                <div className="diff-workspace__header">
                  <div>
                    <span className="diff-workspace__eyebrow">PUBLISHED → STAGED</span>
                    <h3>Patch {state.staged.version} source diff</h3>
                  </div>
                  <span className="diff-workspace__source">
                    {proposalSourceLabel(state.staged.sourceKind)}
                  </span>
                </div>

                <div className="diff-file-tabs" role="tablist" aria-label="Changed source files">
                  {sourcePaths.map((path) => {
                    const pathDiff = diffByPath[path];
                    return (
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeDiffPath === path}
                        className={activeDiffPath === path ? "is-active" : ""}
                        onClick={() => setActiveDiffPath(path)}
                        key={path}
                      >
                        <strong>{path}</strong>
                        <span>
                          <i>+{pathDiff.added}</i>
                          <b>−{pathDiff.removed}</b>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="diff-summary">
                  <span>{activeDiffPath}</span>
                  <p>
                    <strong>+{activeDiff.added}</strong>
                    <b>−{activeDiff.removed}</b>
                  </p>
                </div>

                {activeDiff.rows === null ? (
                  <div className="diff-fallback">
                    <strong>This file is too large for an in-browser line diff.</strong>
                    <span>Open Code to review the complete staged source safely.</span>
                    <button type="button" onClick={() => setActiveTab("code")}>open code</button>
                  </div>
                ) : activeDiff.rows.length === 0 ||
                  (activeDiff.added === 0 && activeDiff.removed === 0) ? (
                  <div className="diff-empty">No changes in {activeDiffPath}.</div>
                ) : (
                  <div className="diff-lines" role="table" aria-label={`${activeDiffPath} line diff`}>
                    {activeDiff.rows.map((line, index) => (
                      <div className={`diff-line diff-line--${line.type}`} role="row" key={`${index}-${line.type}`}>
                        <span className="diff-line__number" role="cell">{line.oldNo ?? ""}</span>
                        <span className="diff-line__number" role="cell">{line.newNo ?? ""}</span>
                        <span className="diff-line__mark" aria-hidden="true">
                          {line.type === "add" ? "+" : line.type === "del" ? "−" : line.type === "hunk" ? "@@" : ""}
                        </span>
                        <code role="cell">{line.text || " "}</code>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
            {activeTab === "showcase" && state && (
              <div className="showcase-workspace">
                <div className="showcase-workspace__header">
                  <div>
                    <span>FORK SHOWCASE · SAME BRANCH POINT, DIFFERENT DIRECTIONS</span>
                    <h3>Compare what the team built</h3>
                  </div>
                  <p>Each card is an immutable published build. Open a branch only when you belong to it.</p>
                </div>
                <div className="showcase-grid">
                  {state.published && (
                    <article className="showcase-card showcase-card--parent">
                      <header>
                        <div>
                          <span>SHARED PARENT</span>
                          <strong>{state.published.name}</strong>
                        </div>
                        <small>v{state.published.version}</small>
                      </header>
                      <iframe
                        title={`${state.published.name} parent preview`}
                        srcDoc={state.published.html}
                        sandbox="allow-scripts"
                        referrerPolicy="no-referrer"
                      />
                      <footer>Current unified build</footer>
                    </article>
                  )}
                  {state.showcase.map((entry) => {
                    const branch = state.branches.find((candidate) => candidate.slug === entry.slug);
                    return (
                      <article className="showcase-card" key={entry.slug}>
                        <header>
                          <div>
                            <span>{entry.ownerName.toUpperCase()}&apos;S FORK</span>
                            <strong>{entry.build.name}</strong>
                          </div>
                          <small>v{entry.build.version}</small>
                        </header>
                        <iframe
                          title={`${entry.ownerName}'s fork preview`}
                          srcDoc={entry.build.html}
                          sandbox="allow-scripts"
                          referrerPolicy="no-referrer"
                        />
                        <footer>
                          <span>Presented {activityTime(entry.presentedAt)}</span>
                          {branch?.role && (
                            <Link href={`/?room=${encodeURIComponent(entry.slug)}`}>open branch →</Link>
                          )}
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
            {activeTab === "activity" && (
              <div className="activity-list">
                {state?.activity.map((activity) => (
                  <div
                    className={`activity-item ${activity.id === visibleBuild?.id ? "activity-item--current" : ""}`}
                    key={activity.id}
                  >
                    <span>{activityTime(activity.createdAt)}</span>
                    <div>
                      <strong>{activity.title}</strong>
                      <p>
                        v{activity.version} · {activity.status} · {activity.summary}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!visibleBuild && activeTab !== "activity" && activeTab !== "diff" && activeTab !== "showcase" && activeTab !== "forks" && activeTab !== "assets" && (
              <div className="empty-build">The first published artifact will appear here.</div>
            )}
          </div>

          <footer className="build-footer">
            <div>
              <span className="build-footer__pulse" />
              <p>
                <strong>
                  {state?.staged
                    ? `Reviewing an unshipped ${proposalSourceLabel(
                        state.staged.sourceKind,
                      ).toLowerCase()}`
                    : "The published build is immutable"}
                </strong>
                <span>
                  {state?.staged
                    ? "Majority backing is required before this replaces anything."
                    : "Every future version remains in the room history."}
                </span>
              </p>
            </div>
            <div className="build-footer__actions">
              {state?.room.parentRoom && (
                <button
                  type="button"
                  onClick={presentToParent}
                  disabled={!state.published || Boolean(busy) || Boolean(state.staged)}
                  title={state.staged ? "Ship the staged proposal before presenting it" : undefined}
                >
                  {busy === "present-parent"
                    ? "presenting…"
                    : state.room.presentedAt
                      ? "refresh showcase ◫"
                      : "present fork ◫"}
                </button>
              )}
              {state?.room.parentRoom && (
                <button
                  type="button"
                  onClick={mergeToParent}
                  disabled={!state.published || Boolean(busy) || Boolean(state.staged)}
                  title={state.staged ? "Ship the fork proposal before merging it" : undefined}
                >
                  {busy === "merge-parent" ? "combining…" : "merge parent ↗"}
                </button>
              )}
              <button
                type="button"
                onClick={fork}
                disabled={!state?.published || Boolean(busy) || Boolean(state?.staged)}
                title={state?.staged ? "Ship the staged proposal before branching again" : undefined}
              >
                {state?.room.parentRoom ? "fork again →" : "fork this app →"}
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </main>
  );
}
