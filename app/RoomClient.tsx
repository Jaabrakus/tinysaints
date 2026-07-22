"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

type Color = "lime" | "violet" | "coral" | "sky" | "cream";

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

type Props = {
  initialUser: { displayName: string };
  initialSlug: string;
  signOutPath: string;
};

const colors: Color[] = ["coral", "violet", "sky", "cream", "lime"];

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
  const [activeTab, setActiveTab] = useState<"preview" | "code" | "activity">(
    "preview",
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("Room history is saved automatically");
  const [newRoomOpen, setNewRoomOpen] = useState(false);
  const [newRoomName, setNewRoomName] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  const loadRoom = useCallback(
    async (inviteToken?: string | null) => {
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
        setState(await readResponse<RoomState>(response));
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
    async <T,>(action: string, extra: Record<string, string> = {}) => {
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
    setNotice("Kimi is reading the canonical room history and building…");
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      setState(await readResponse<RoomState>(response));
      setActiveTab("preview");
      setNotice("A real artifact is staged · back it before shipping");
    } catch (generationError) {
      setError(
        generationError instanceof Error
          ? generationError.message
          : "Kimi could not finish the artifact.",
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
      setState(await mutateRoom<RoomState>("vote"));
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

  const visibleBuild = state?.staged ?? state?.published;
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
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="Make Room home">
          <span className="wordmark__spark">✳</span>
          <span>make/room</span>
        </Link>

        <div className="room-heading">
          <span className="room-heading__parent">rooms</span>
          <span className="room-heading__slash">/</span>
          <strong>{state?.room.name ?? "loading"}</strong>
          <span className="live-dot" aria-label="Room sync is active" />
        </div>

        <div className="topbar__actions">
          <span className={`engine-pill ${state && !state.model.configured ? "engine-pill--blocked" : ""}`}>
            <span className="engine-pill__dot" />
            {state?.model.configured ? `${state.model.name} live` : "K3 key needed"}
          </span>
          {state?.room.canInvite && (
            <button className="quiet-button" type="button" onClick={makeInvite} disabled={Boolean(busy)}>
              {busy === "invite" ? "creating…" : "invite"}
            </button>
          )}
          <button className="quiet-button" type="button" onClick={fork} disabled={!state || Boolean(busy)}>
            {busy === "fork" ? "forking…" : `fork · ${state?.room.forkCount ?? 0}`}
          </button>
          <a
            className={`avatar avatar--${colorFor(state?.user.id ?? currentUserName)} avatar--you`}
            href={signOutPath}
            title={`Sign out ${currentUserName}`}
            aria-label={`Sign out ${currentUserName}`}
          >
            {initials(currentUserName)}
          </a>
        </div>
      </header>

      <div className="workspace">
        <aside className="room-rail" aria-label="Your rooms">
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

        <section className="conversation" aria-label="Room conversation">
          <div className="conversation__header">
            <div>
              <p className="section-kicker">ROOM CHAT · SAVED</p>
              <h1>{state?.room.note ?? "Opening the room…"}</h1>
            </div>
            <span className="icon-button" title="Signed-in room">i</span>
          </div>

          <div className="room-note">
            <span>COLLECTIVE CONTRACT</span>
            <p>Messages become proposals. Proposals need a majority. Published builds never change silently.</p>
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
                <span>REAL PROPOSAL · PATCH {state.staged.version}</span>
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
                {busy === "synthesize" ? "building with Kimi…" : "synthesize real build ✳"}
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
            <p className="composer-hint">SIGNED IN AS {currentUserName.toUpperCase()} · ROOM WRITES ARE ATTRIBUTED</p>
          </div>
        </section>

        <aside className="build-panel" aria-label="Generated app">
          <div className="build-panel__header">
            <div>
              <p className="section-kicker">THE WORKING ARTIFACT</p>
              <h2>{visibleBuild?.name ?? "No build yet"}</h2>
            </div>
            <div className="version-chip">
              <span className={state?.staged ? "status-dot status-dot--staged" : "status-dot"} />
              {state?.staged
                ? `staging v${state.staged.version}`
                : state?.published
                  ? `live · v${state.published.version}`
                  : "waiting"}
            </div>
          </div>

          <div className="build-tabs" role="tablist" aria-label="Build views">
            {(["preview", "code", "activity"] as const).map((tabName) => (
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === tabName}
                className={activeTab === tabName ? "is-active" : ""}
                onClick={() => setActiveTab(tabName)}
                key={tabName}
              >
                {tabName}
              </button>
            ))}
            <span className="sandbox-label">scriptless sandbox</span>
          </div>

          <div className="build-stage">
            {state?.staged && activeTab !== "activity" && (
              <div className="staged-banner">
                <span>STAGED · NOT PUBLISHED</span>
                <span>{state.staged.sourceMessageIds.length} source messages</span>
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
              <div className="code-preview">
                <div className="code-preview__path">
                  <span>artifact</span>
                  <span>/</span>
                  <strong>index.html</strong>
                  <span className="code-preview__safe">opaque origin</span>
                </div>
                <pre>
                  <code>{visibleBuild.html}</code>
                </pre>
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
            {!visibleBuild && activeTab !== "activity" && (
              <div className="empty-build">The first published artifact will appear here.</div>
            )}
          </div>

          <footer className="build-footer">
            <div>
              <span className="build-footer__pulse" />
              <p>
                <strong>
                  {state?.staged ? "Previewing an unshipped Kimi artifact" : "The published build is immutable"}
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
