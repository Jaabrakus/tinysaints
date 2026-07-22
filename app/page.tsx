"use client";

import { FormEvent, useMemo, useState } from "react";

type Accent = "lime" | "violet" | "coral" | "sky";

type AppCard = {
  title: string;
  detail: string;
  meta: string;
};

type AppSpec = {
  name: string;
  eyebrow: string;
  headline: string;
  subheadline: string;
  accent: Accent;
  cards: AppCard[];
  cta: string;
};

type BuildProposal = {
  title: string;
  rationale: string;
};

type GenerateResponse = {
  mode: "live" | "demo";
  model: string;
  summary: string;
  app: AppSpec;
  changes: string[];
  proposal: BuildProposal;
  warning?: string;
};

type Message = {
  id: number;
  author: string;
  initials: string;
  color: "lime" | "violet" | "coral" | "sky" | "cream";
  time: string;
  text: string;
  role?: "maker" | "agent" | "system";
};

const publishedApp: AppSpec = {
  name: "tiny plans",
  eyebrow: "TONIGHT · WITHIN 2 MILES",
  headline: "What kind of night do you need?",
  subheadline: "Three good options. No feed, no planning spiral.",
  accent: "lime",
  cards: [
    {
      title: "Low-key",
      detail: "Tea, a walk, somewhere you can hear each other.",
      meta: "4 people nearby",
    },
    {
      title: "Move around",
      detail: "Pick-up game, night market, or a long loop home.",
      meta: "2 plans forming",
    },
    {
      title: "Surprise me",
      detail: "Let the room choose one slightly unusual thing.",
      meta: "Feeling lucky",
    },
  ],
  cta: "show me three plans",
};

const stagedApp: AppSpec = {
  ...publishedApp,
  headline: "How much social battery do you have?",
  subheadline: "Start with your energy. The room handles the logistics.",
  accent: "violet",
  cards: [
    {
      title: "One-on-one",
      detail: "Quiet company, minimal decisions, home before ten.",
      meta: "25% battery",
    },
    {
      title: "A small orbit",
      detail: "Three to five people and one loose destination.",
      meta: "55% battery",
    },
    {
      title: "Bring the noise",
      detail: "Open invite, music, movement, stay as long as you like.",
      meta: "90% battery",
    },
  ],
  cta: "match my energy",
};

const seedMessages: Message[] = [
  {
    id: 1,
    author: "Nia",
    initials: "NI",
    color: "coral",
    time: "9:14",
    text: "What if it only asks two things: what do you feel like doing, and how far will you go?",
  },
  {
    id: 2,
    author: "Jules",
    initials: "JU",
    color: "violet",
    time: "9:16",
    text: "Yes—and no infinite feed. Give us three possible plans, max. Choosing is the whole problem.",
  },
  {
    id: 3,
    author: "Marco",
    initials: "MA",
    color: "sky",
    time: "9:18",
    text: "Let people say ‘I’m in’ without accidentally becoming the event organizer.",
  },
  {
    id: 4,
    author: "Kimi",
    initials: "K3",
    color: "lime",
    time: "9:19",
    role: "agent",
    text: "Shared direction found: make energy—not activity—the first choice. I staged a three-state social-battery patch for the room.",
  },
];

const rooms = [
  { symbol: "✦", name: "tiny plans", note: "4 here", active: true },
  { symbol: "◌", name: "meal train", note: "2 new" },
  { symbol: "↗", name: "night market", note: "away" },
  { symbol: "□", name: "soft launch", note: "quiet" },
];

const makers = [
  { initials: "NI", color: "coral", label: "Nia is online" },
  { initials: "JU", color: "violet", label: "Jules is online" },
  { initials: "MA", color: "sky", label: "Marco is online" },
  { initials: "YO", color: "cream", label: "You are online" },
] as const;

function clockTime() {
  return new Intl.DateTimeFormat("en", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function AppPreview({ app }: { app: AppSpec }) {
  const [selected, setSelected] = useState(0);
  const [revealed, setRevealed] = useState(false);

  return (
    <div className={`mini-app accent-${app.accent}`}>
      <div className="mini-app__chrome">
        <span className="mini-app__mark">t/p</span>
        <span className="mini-app__name">{app.name}</span>
        <button className="mini-app__more" type="button" aria-label="App menu">
          ···
        </button>
      </div>

      <div className="mini-app__content">
        <p className="mini-app__eyebrow">{app.eyebrow}</p>
        <h2>{app.headline}</h2>
        <p className="mini-app__subhead">{app.subheadline}</p>

        <div className="mood-list" role="radiogroup" aria-label="Choose your energy">
          {app.cards.map((card, index) => (
            <button
              type="button"
              role="radio"
              aria-checked={selected === index}
              className={`mood-card ${selected === index ? "is-selected" : ""}`}
              onClick={() => {
                setSelected(index);
                setRevealed(false);
              }}
              key={card.title}
            >
              <span className="mood-card__index">0{index + 1}</span>
              <span className="mood-card__copy">
                <strong>{card.title}</strong>
                <span>{card.detail}</span>
              </span>
              <span className="mood-card__meta">{card.meta}</span>
            </button>
          ))}
        </div>

        <button
          className="mini-app__cta"
          type="button"
          onClick={() => setRevealed(true)}
        >
          {revealed ? "2 people are in · join them →" : `${app.cta} →`}
        </button>
      </div>
    </div>
  );
}

function CodePreview({ app }: { app: AppSpec }) {
  const code = useMemo(
    () =>
      JSON.stringify(
        {
          app: app.name,
          route: "/tonight",
          question: app.headline,
          choices: app.cards.map(({ title, meta }) => ({ title, signal: meta })),
          action: app.cta,
        },
        null,
        2,
      ),
    [app],
  );

  return (
    <div className="code-preview">
      <div className="code-preview__path">
        <span>app</span>
        <span>/</span>
        <strong>room.json</strong>
        <span className="code-preview__safe">safe spec</span>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState(seedMessages);
  const [draft, setDraft] = useState("");
  const [published, setPublished] = useState(publishedApp);
  const [staged, setStaged] = useState<AppSpec | null>(stagedApp);
  const [proposal, setProposal] = useState<BuildProposal>({
    title: "Lead with social battery",
    rationale:
      "Everyone is describing the energy they have before the activity they want. Make that the first interaction.",
  });
  const [changes, setChanges] = useState([
    "Reframed the opening question",
    "Added three energy states",
    "Shortened the final decision",
  ]);
  const [activeTab, setActiveTab] = useState<"preview" | "code" | "activity">(
    "preview",
  );
  const [version, setVersion] = useState(12);
  const [votes, setVotes] = useState(3);
  const [hasVoted, setHasVoted] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [engine, setEngine] = useState("K3 ready");
  const [notice, setNotice] = useState("3 ideas became this patch");
  const [forkCount, setForkCount] = useState(18);
  const [roomName, setRoomName] = useState("tiny plans");

  const visibleApp = staged ?? published;

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;

    setMessages((current) => [
      ...current,
      {
        id: Date.now(),
        author: "You",
        initials: "YO",
        color: "cream",
        time: clockTime(),
        text,
      },
    ]);
    setDraft("");
    setNotice("New thought added · ready to synthesize");
  }

  async function synthesizeThread() {
    setIsGenerating(true);
    setNotice("Reading for shared intent…");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt:
            messages.at(-1)?.text ??
            "Turn this room's shared direction into the next useful patch.",
          messages: messages.map(({ author, text }) => ({ author, text })),
          currentApp: published,
        }),
      });

      if (!response.ok) throw new Error("The synthesis request failed.");

      const result = (await response.json()) as GenerateResponse;
      setStaged(result.app);
      setProposal(result.proposal);
      setChanges(result.changes);
      setEngine(result.mode === "live" ? result.model : "demo engine");
      setVotes(1);
      setHasVoted(true);
      setNotice(
        result.mode === "live"
          ? "Kimi turned the thread into a safe app patch"
          : "Demo synthesis staged · add a Kimi key for live reasoning",
      );
      setMessages((current) => [
        ...current,
        {
          id: Date.now() + 1,
          author: "Kimi",
          initials: "K3",
          color: "lime",
          time: clockTime(),
          role: "agent",
          text: result.summary,
        },
      ]);
      setActiveTab("preview");
    } catch {
      setNotice("Couldn’t synthesize that yet · your message is still here");
    } finally {
      setIsGenerating(false);
    }
  }

  function toggleVote() {
    setHasVoted((current) => {
      setVotes((count) => Math.max(0, count + (current ? -1 : 1)));
      return !current;
    });
  }

  function shipPatch() {
    if (!staged) return;
    setPublished(staged);
    setStaged(null);
    setVersion((current) => current + 1);
    setNotice("Patch shipped to everyone in the room");
    setMessages((current) => [
      ...current,
      {
        id: Date.now() + 2,
        author: "Room",
        initials: "✓",
        color: "lime",
        time: clockTime(),
        role: "system",
        text: `The room shipped “${proposal.title}.” The shared app is now live at v${version + 1}.`,
      },
    ]);
  }

  function forkRoom() {
    if (!roomName.includes("your fork")) {
      setRoomName(`${roomName} / your fork`);
      setForkCount((current) => current + 1);
      setVersion(1);
      setNotice("Fork made · this branch is yours to reshape");
    }
  }

  return (
    <main className="product-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Make Room home">
          <span className="wordmark__spark">✳</span>
          <span>make/room</span>
        </a>

        <div className="room-heading" id="top">
          <span className="room-heading__parent">rooms</span>
          <span className="room-heading__slash">/</span>
          <strong>{roomName}</strong>
          <span className="live-dot" aria-label="Room is live" />
        </div>

        <div className="topbar__actions">
          <span className="engine-pill">
            <span className="engine-pill__dot" />
            {engine}
          </span>
          <button className="quiet-button" type="button" onClick={forkRoom}>
            fork · {forkCount}
          </button>
          <button className="avatar avatar--cream avatar--you" type="button" aria-label="Your profile">
            YO
          </button>
        </div>
      </header>

      <div className="workspace">
        <aside className="room-rail" aria-label="Your rooms">
          <div className="rail-section-label">
            <span>your rooms</span>
            <button type="button" aria-label="Create a room">
              +
            </button>
          </div>

          <nav className="room-list">
            {rooms.map((room) => (
              <button
                type="button"
                className={`room-link ${room.active ? "is-active" : ""}`}
                key={room.name}
              >
                <span className="room-link__symbol">{room.symbol}</span>
                <span className="room-link__copy">
                  <strong>{room.name}</strong>
                  <small>{room.note}</small>
                </span>
              </button>
            ))}
          </nav>

          <div className="rail-callout">
            <span className="rail-callout__eyebrow">THE PREMISE</span>
            <p>Every room can become a thing people use.</p>
            <button type="button">read the field notes ↗</button>
          </div>

          <div className="presence-panel">
            <div className="presence-stack">
              {makers.map((maker) => (
                <span
                  className={`avatar avatar--${maker.color}`}
                  title={maker.label}
                  key={maker.initials}
                >
                  {maker.initials}
                </span>
              ))}
            </div>
            <p>
              <strong>4 making</strong>
              <span>no spectators</span>
            </p>
          </div>
        </aside>

        <section className="conversation" aria-label="Room conversation">
          <div className="conversation__header">
            <div>
              <p className="section-kicker">ROOM CHAT</p>
              <h1>Build the plan, not the group chat.</h1>
            </div>
            <button className="icon-button" type="button" aria-label="Room details">
              i
            </button>
          </div>

          <div className="room-note">
            <span>AWAY MESSAGE</span>
            <p>Trying to make spontaneous plans feel spontaneous again.</p>
          </div>

          <div className="message-list" aria-live="polite">
            {messages.map((message) => (
              <article
                className={`message message--${message.role ?? "maker"}`}
                key={message.id}
              >
                <span className={`avatar avatar--${message.color}`} aria-hidden="true">
                  {message.initials}
                </span>
                <div className="message__body">
                  <div className="message__meta">
                    <strong>{message.author}</strong>
                    {message.role === "agent" && <span className="agent-tag">SYNTHESIS</span>}
                    <time>{message.time}</time>
                  </div>
                  <p>{message.text}</p>
                </div>
              </article>
            ))}
          </div>

          {staged && (
            <article className="proposal-card">
              <div className="proposal-card__topline">
                <span>PROPOSAL · PATCH {version + 1}</span>
                <span>{votes}/4 back it</span>
              </div>
              <h2>{proposal.title}</h2>
              <p>{proposal.rationale}</p>

              <ul>
                {changes.slice(0, 3).map((change) => (
                  <li key={change}>
                    <span>+</span>
                    {change}
                  </li>
                ))}
              </ul>

              <div className="proposal-card__actions">
                <div className="micro-stack" aria-label={`${votes} votes`}>
                  {makers.slice(0, votes).map((maker) => (
                    <span className={`avatar avatar--${maker.color}`} key={maker.initials}>
                      {maker.initials}
                    </span>
                  ))}
                </div>
                <button
                  className={`vote-button ${hasVoted ? "is-backed" : ""}`}
                  type="button"
                  onClick={toggleVote}
                >
                  {hasVoted ? "backed ✓" : "back this"}
                </button>
                <button className="ship-button" type="button" onClick={shipPatch}>
                  ship to room →
                </button>
              </div>
            </article>
          )}

          <div className="composer-wrap">
            <div className="synthesis-line">
              <span>{notice}</span>
              <button
                type="button"
                onClick={synthesizeThread}
                disabled={isGenerating}
              >
                {isGenerating ? "synthesizing…" : "synthesize thread ✳"}
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
              <button type="submit" disabled={!draft.trim()} aria-label="Send message">
                ↑
              </button>
            </form>
            <p className="composer-hint">ENTER TO SEND · SHIFT + ENTER FOR A NEW LINE</p>
          </div>
        </section>

        <aside className="build-panel" aria-label="Generated app">
          <div className="build-panel__header">
            <div>
              <p className="section-kicker">THE THING</p>
              <h2>{published.name}</h2>
            </div>
            <div className="version-chip">
              <span className={staged ? "status-dot status-dot--staged" : "status-dot"} />
              {staged ? `staging v${version + 1}` : `live · v${version}`}
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
            <button className="open-button" type="button" aria-label="Open full app">
              ↗
            </button>
          </div>

          <div className="build-stage">
            {staged && activeTab !== "activity" && (
              <div className="staged-banner">
                <span>STAGED FROM CHAT</span>
                <button type="button" onClick={() => setStaged(null)}>
                  discard
                </button>
              </div>
            )}
            {activeTab === "preview" && <AppPreview app={visibleApp} />}
            {activeTab === "code" && <CodePreview app={visibleApp} />}
            {activeTab === "activity" && (
              <div className="activity-list">
                <div className="activity-item activity-item--current">
                  <span>NOW</span>
                  <div>
                    <strong>{staged ? proposal.title : "Room is in sync"}</strong>
                    <p>{staged ? "Staged from 3 room messages" : `Published as v${version}`}</p>
                  </div>
                </div>
                <div className="activity-item">
                  <span>9:03</span>
                  <div>
                    <strong>Removed the public follower count</strong>
                    <p>Nia + Marco · shipped in v12</p>
                  </div>
                </div>
                <div className="activity-item">
                  <span>YDAY</span>
                  <div>
                    <strong>Forked from “third place finder”</strong>
                    <p>Jules brought over 6 useful pieces</p>
                  </div>
                </div>
              </div>
            )}
          </div>

          <footer className="build-footer">
            <div>
              <span className="build-footer__pulse" />
              <p>
                <strong>{staged ? "Previewing the room’s next idea" : "Everyone has the latest build"}</strong>
                <span>{staged ? "Nothing changes until the room ships it." : "The app and conversation share one history."}</span>
              </p>
            </div>
            <button type="button" onClick={forkRoom}>fork this app →</button>
          </footer>
        </aside>
      </div>
    </main>
  );
}
