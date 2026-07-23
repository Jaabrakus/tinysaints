"use client";

import { FormEvent, useState } from "react";

export default function GuestEntry({ requestedRoom }: { requestedRoom: string }) {
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (displayName.trim().length < 2 || busy) return;
    setBusy(true);
    setError(null);
    const response = await fetch("/api/guest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: displayName.trim() }),
    });
    if (!response.ok) {
      const payload = (await response.json()) as { error?: string };
      setError(payload.error ?? "The guest workspace could not start.");
      setBusy(false);
      return;
    }
    window.location.reload();
  }

  const returnTo = requestedRoom ? `/?room=${encodeURIComponent(requestedRoom)}` : "/";
  return (
    <main className="guest-entry">
      <section>
        <div className="guest-entry__brand"><i /> make/room</div>
        <span>{requestedRoom ? "ROOM INVITE" : "COLLABORATIVE GAME STUDIO"}</span>
        <h1>{requestedRoom ? "Join the room without making an account." : "Start building together."}</h1>
        <p>Pick a room name for yourself. Your guest session stays on this device for 30 days; project access still requires a valid room invite.</p>
        <form onSubmit={enter}>
          <label htmlFor="guest-name">What should the room call you?</label>
          <div>
            <input id="guest-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={40} placeholder="Kiwi" autoFocus />
            <button type="submit" disabled={displayName.trim().length < 2 || busy}>{busy ? "opening…" : "enter studio →"}</button>
          </div>
          {error && <small role="alert">{error}</small>}
        </form>
        <a href={`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`}>or continue with ChatGPT</a>
      </section>
    </main>
  );
}
