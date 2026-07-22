"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { buildDiffLines, diffStats } from "../lib/kimi-code-diff";

type Color = "lime" | "violet" | "coral" | "sky" | "cream";
type SourcePath = "index.html" | "styles.css";
type RoomActionValue = string | number | boolean | null;

type SourceFile = {
  path: SourcePath;
  content: string;
  language: "html" | "css";
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
  parentBuildId: string | null;
  files: SourceFile[];
  createdBy: string;
  createdAt: string;
  publishedAt: string | null;
};

type RoomState = {
  room: {
    id: string;
    slug: string;
    name: string;
    note: string;
    parentRoomId: string | null;
    forkCount: number;
    canInvite: boolean;
    revision: number;
  };
  user: { id: string; displayName: string };
  rooms: Array<{ slug: string; name: string; updatedAt: string; role: string }>;
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
const sourcePaths: SourcePath[] = ["index.html", "styles.css"];

function getSourceFile(build: Build | null | undefined, path: SourcePath) {
  return build?.files.find((file) => file.path === path) ?? null;
}

function proposalSourceLabel(sourceKind: string) {
  if (sourceKind === "manual") return "MANUAL EDIT";
  if (sourceKind === "kimi") return "KIMI SYNTHESIS";
  return sourceKind.replaceAll("-", " ").toUpperCase() || "ROOM PATCH";
}

function utf8ByteCount(value: string) {
  return new TextEncoder().encode(value).byteLength;
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
  const [activeTab, setActiveTab] = useState<"preview" | "code" | "diff" | "activity">(
    "code",
  );
  const [activeSourcePath, setActiveSourcePath] = useState<SourcePath>("index.html");
  const [activeDiffPath, setActiveDiffPath] = useState<SourcePath>("index.html");
  const [sourceDrafts, setSourceDrafts] = useState<Partial<Record<SourcePath, SourceDraft>>>({});
  const [editorStatus, setEditorStatus] = useState<EditorStatus>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Room history is saved automatically");
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const loadSequence = useRef(0);
  const editorGutter = useRef<HTMLPreElement>(null);
  const conversationPane = useRef<HTMLElement>(null);
  const buildPane = useRef<HTMLElement>(null);

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
      const inviteToken = new URLSearchParams(window.location.hash.slice(1)).get("invite");
      void loadRoom(inviteToken);
    }, 0);
    const interval = window.setInterval(() => {
      if (!document.hidden) void loadRoom();
    }, 5_000);
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
    if (!state || busy) return;
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

  async function makeRoom(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newRoomName.trim() || busy) return;
    setBusy("create");
    setError(null);
    try {
      const result = await mutateRoom<{ slug: string }>("create", { name: newRoomName });
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

  function updateSourceDraft(content: string) {
    if (!state || !visibleBuild) return;
    const sourceFile = getSourceFile(visibleBuild, activeSourcePath);
    if (!sourceFile) return;

    setSourceDrafts((current) => {
      const existing = current[activeSourcePath] ?? {
        content: sourceFile.content,
        baseContent: sourceFile.content,
        baseBuildId: visibleBuild.id,
        expectedRevision: state.room.revision,
      };
      const next = { ...current };

      if (content === existing.baseContent) {
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
  const editorLineNumbers = Array.from(
    { length: Math.max(1, editorValue.split("\n").length) },
    (_, index) => index + 1,
  ).join("\n");
  const diffByPath = useMemo(() => {
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
  }, [state?.published, state?.staged]);
  const activeDiff = diffByPath[activeDiffPath];
  const voterMembers = useMemo(
    () =>
      state?.members.filter((member) => state.votes.voterIds.includes(member.id)) ?? [],
    [state],
  );
  const onlineMembers =
    state?.members.filter((member) => member.online) ?? [];
  const currentUserName = state?.user.displayName ?? initialUser.displayName;

  return (
    <main className="product-shell">
      <div className="workspace">
        <aside className="room-rail" aria-label="Your rooms">
          <div className="rail-brand">
            <Link className="wordmark" href="/" aria-label="Make Room home">
              <span className="wordmark__spark">✳</span>
              <span>make/room</span>
            </Link>
            <span className="rail-brand__mode">COLLAB IDE</span>
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
              <button type="submit" disabled={!newRoomName.trim() || Boolean(busy)}>
                make →
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
            <span>ROOM RULES</span>
            <p>Thread → patch → review → majority ship. Published builds never change silently.</p>
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
              <p className="section-kicker">WORKSPACE · ARTIFACT</p>
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
              <button className="quiet-button" type="button" onClick={fork} disabled={!state || Boolean(busy)}>
                {busy === "fork" ? "forking…" : `fork · ${state?.room.forkCount ?? 0}`}
              </button>
            </div>
          </div>

          <div className="build-tabs" role="tablist" aria-label="Build views">
            {(["preview", "code", "diff", "activity"] as const).map((tabName) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tabName}
                className={activeTab === tabName ? "is-active" : ""}
                onClick={() => setActiveTab(tabName)}
                disabled={tabName === "diff" && !state?.staged}
                title={tabName === "diff" && !state?.staged ? "Stage a source patch to compare it" : undefined}
                key={tabName}
              >
                {tabName}
              </button>
            ))}
            <span className="sandbox-label"><i /> scriptless sandbox</span>
          </div>

          <div
            className={`build-stage ${activeTab === "code" || activeTab === "diff" ? "build-stage--ide" : ""}`}
          >
            {state?.staged && activeTab !== "activity" && (
              <div className="staged-banner">
                <span>{proposalSourceLabel(state.staged.sourceKind)} · STAGED, NOT PUBLISHED</span>
                <span>
                  {state.staged.sourceKind === "manual"
                    ? "room source edit"
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
                sandbox=""
                referrerPolicy="no-referrer"
              />
            )}
            {activeTab === "code" && visibleBuild && (
              <div className="source-workspace">
                <aside className="source-files" aria-label="Artifact source files">
                  <div className="source-files__heading">
                    <span>SOURCE</span>
                    <small>2 files</small>
                  </div>
                  {sourcePaths.map((path) => {
                    const file = getSourceFile(visibleBuild, path);
                    const fileDraft = sourceDrafts[path];
                    const isDirty = Boolean(fileDraft && fileDraft.content !== fileDraft.baseContent);
                    return (
                      <button
                        className={`${activeSourcePath === path ? "is-active" : ""} ${isDirty ? "is-dirty" : ""}`}
                        type="button"
                        onClick={() => setActiveSourcePath(path)}
                        disabled={!file}
                        aria-current={activeSourcePath === path ? "page" : undefined}
                        key={path}
                      >
                        <span className={`file-glyph file-glyph--${file?.language ?? "html"}`}>
                          {file?.language === "css" ? "#" : "<>"}
                        </span>
                        <span>
                          <strong>{path}</strong>
                          <small>{file ? `${file.byteCount.toLocaleString()} bytes` : "unavailable"}</small>
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

                  <label className="source-editor__input">
                    <span>Edit {activeSourcePath}</span>
                    <div className="source-editor__code-area">
                      <pre ref={editorGutter} className="source-editor__gutter" aria-hidden="true">
                        {editorLineNumbers}
                      </pre>
                      <textarea
                        value={editorValue}
                        onChange={(event) => updateSourceDraft(event.target.value)}
                        onScroll={(event) => {
                          if (editorGutter.current) {
                            editorGutter.current.scrollTop = event.currentTarget.scrollTop;
                          }
                        }}
                        onKeyDown={(event) => {
                          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                            event.preventDefault();
                            void saveSourceProposal();
                          }
                        }}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        maxLength={65_536}
                        aria-label={`Source for ${activeSourcePath}`}
                      />
                    </div>
                  </label>

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
            {!visibleBuild && activeTab !== "activity" && activeTab !== "diff" && (
              <div className="empty-build">The first published artifact will appear here.</div>
            )}
          </div>

          <footer className="build-footer">
            <div>
              <span className="build-footer__pulse" />
              <p>
                <strong>
                  {state?.staged
                    ? `Reviewing an unshipped ${
                        state.staged.sourceKind === "manual" ? "room edit" : "Kimi patch"
                      }`
                    : "The published build is immutable"}
                </strong>
                <span>
                  {state?.staged
                    ? "Majority backing is required before this replaces anything."
                    : "Every future version remains in the room history."}
                </span>
              </p>
            </div>
            <button type="button" onClick={fork} disabled={!state?.published || Boolean(busy)}>
              fork this app →
            </button>
          </footer>
        </aside>
      </div>
    </main>
  );
}
