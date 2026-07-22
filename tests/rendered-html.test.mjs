import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const env = {
  ASSETS: {
    fetch: async () => new Response("Not found", { status: 404 }),
  },
};

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

test("renders the make/room product instead of the starter", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    env,
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /make\/room/i);
  assert.match(html, /Build the plan, not the group chat\./i);
  assert.match(html, /synthesize thread/i);
  assert.match(html, /ship to room/i);
  assert.match(html, /tiny plans/i);
  assert.match(html, /the group chat that becomes an app/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("keeps model credentials server-side and provides a demo synthesis", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "Make it work for a quiet walk outside.",
        messages: [
          { author: "Nia", text: "I want something low-key." },
          { author: "Jules", text: "A short walk would be enough." },
        ],
        currentApp: {
          name: "tiny plans",
          eyebrow: "TONIGHT",
          headline: "What do you need?",
          subheadline: "Three choices.",
          accent: "lime",
          cards: [
            { title: "One", detail: "First", meta: "Ready" },
            { title: "Two", detail: "Second", meta: "Ready" },
            { title: "Three", detail: "Third", meta: "Ready" },
          ],
          cta: "choose",
        },
      }),
    }),
    env,
    context,
  );

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.mode, "demo");
  assert.equal(result.app.cards.length, 3);
  assert.equal(result.changes.length, 3);
  assert.match(result.app.headline, /company|wander/i);

  const [page, provider, envExample] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/model-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../.env.example", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(page, /MOONSHOT_API_KEY|KIMI_API_KEY|AI_API_KEY/);
  assert.match(provider, /process\.env\.MOONSHOT_API_KEY/);
  assert.match(provider, /model: "kimi-k3"|"kimi-k3"/);
  assert.match(envExample, /MOONSHOT_API_KEY=/);
});
