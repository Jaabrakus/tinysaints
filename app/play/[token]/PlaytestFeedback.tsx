"use client";

import { FormEvent, useState } from "react";

export default function PlaytestFeedback({ token }: { token: string }) {
  const [name, setName] = useState("");
  const [rating, setRating] = useState(5);
  const [body, setBody] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!body.trim() || status === "saving") return;
    setStatus("saving");
    const response = await fetch("/api/playtest-feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, displayName: name, rating, body }),
    });
    if (!response.ok) {
      setStatus("error");
      return;
    }
    setBody("");
    setStatus("saved");
  }

  return (
    <form className="public-playtest__feedback" onSubmit={submit}>
      <div>
        <span>PLAYTEST REPORT</span>
        <strong>{status === "saved" ? "Feedback received—thank you." : "What worked, and what broke?"}</strong>
      </div>
      <input value={name} onChange={(event) => setName(event.target.value)} maxLength={60} placeholder="Your name (optional)" />
      <label>
        <span>Rating</span>
        <select value={rating} onChange={(event) => setRating(Number(event.target.value))}>
          <option value={5}>5 · great</option>
          <option value={4}>4 · good</option>
          <option value={3}>3 · mixed</option>
          <option value={2}>2 · rough</option>
          <option value={1}>1 · blocked</option>
        </select>
      </label>
      <textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={1200} rows={3} placeholder="Describe the moment, bug, or idea…" required />
      <button type="submit" disabled={!body.trim() || status === "saving"}>{status === "saving" ? "sending…" : "send report →"}</button>
      {status === "error" && <small>That report did not save. Refresh and try once more.</small>}
    </form>
  );
}
