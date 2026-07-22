export type Accent = "lime" | "violet" | "coral" | "sky";

export type AppSpec = {
  name: string;
  eyebrow: string;
  headline: string;
  subheadline: string;
  accent: Accent;
  cards: Array<{
    title: string;
    detail: string;
    meta: string;
  }>;
  cta: string;
};

export type GenerateBuildInput = {
  prompt: string;
  messages: Array<{ author: string; text: string }>;
  currentApp: AppSpec;
};

export type BuildResult = {
  mode: "live" | "demo";
  model: string;
  summary: string;
  app: AppSpec;
  changes: string[];
  proposal: {
    title: string;
    rationale: string;
  };
  warning?: string;
};

const responseSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    app: {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        eyebrow: { type: "string" },
        headline: { type: "string" },
        subheadline: { type: "string" },
        accent: { type: "string", enum: ["lime", "violet", "coral", "sky"] },
        cards: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              title: { type: "string" },
              detail: { type: "string" },
              meta: { type: "string" },
            },
            required: ["title", "detail", "meta"],
          },
        },
        cta: { type: "string" },
      },
      required: [
        "name",
        "eyebrow",
        "headline",
        "subheadline",
        "accent",
        "cards",
        "cta",
      ],
    },
    changes: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: { type: "string" },
    },
    proposal: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["title", "rationale"],
    },
  },
  required: ["summary", "app", "changes", "proposal"],
} as const;

function text(value: unknown, fallback: string, maxLength: number) {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maxLength)
    : fallback;
}

function sanitizeApp(value: unknown, fallback: AppSpec): AppSpec {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<AppSpec>;
  const allowedAccents: Accent[] = ["lime", "violet", "coral", "sky"];
  const cards = Array.isArray(candidate.cards)
    ? candidate.cards.slice(0, 3).map((card, index) => ({
        title: text(card?.title, fallback.cards[index]?.title ?? "A good option", 34),
        detail: text(card?.detail, fallback.cards[index]?.detail ?? "Made by the room.", 100),
        meta: text(card?.meta, fallback.cards[index]?.meta ?? "Ready", 32),
      }))
    : fallback.cards;

  while (cards.length < 3) cards.push(fallback.cards[cards.length]);

  return {
    name: text(candidate.name, fallback.name, 32),
    eyebrow: text(candidate.eyebrow, fallback.eyebrow, 48).toUpperCase(),
    headline: text(candidate.headline, fallback.headline, 80),
    subheadline: text(candidate.subheadline, fallback.subheadline, 140),
    accent: allowedAccents.includes(candidate.accent as Accent)
      ? (candidate.accent as Accent)
      : fallback.accent,
    cards,
    cta: text(candidate.cta, fallback.cta, 40),
  };
}

function demoBuild(input: GenerateBuildInput, warning?: string): BuildResult {
  const idea = `${input.prompt} ${input.messages.map((message) => message.text).join(" ")}`.toLowerCase();
  const lastThought = text(input.prompt, "the room's newest idea", 78);

  let app: AppSpec;
  let proposalTitle: string;
  let rationale: string;

  if (/quiet|low.key|battery|tired|introvert/.test(idea)) {
    app = {
      ...input.currentApp,
      headline: "How much company sounds good?",
      subheadline: "Choose the amount of social—not the perfect activity.",
      accent: "violet",
      cards: [
        { title: "Just one person", detail: "A familiar face and an easy exit.", meta: "2 matches" },
        { title: "A tiny circle", detail: "Three to five people, somewhere calm.", meta: "4 nearby" },
        { title: "Open to whoever", detail: "More energy, still no host duties.", meta: "1 plan live" },
      ],
      cta: "find my level",
    };
    proposalTitle = "Match the room to your battery";
    rationale = "The thread is optimizing for emotional effort before logistics, so the app should ask about company size first.";
  } else if (/walk|outside|park|outdoor|distance/.test(idea)) {
    app = {
      ...input.currentApp,
      eyebrow: "OUTSIDE · STARTING NEAR YOU",
      headline: "How far do you want to wander?",
      subheadline: "A lightweight plan that starts with distance and lets company follow.",
      accent: "sky",
      cards: [
        { title: "Around the block", detail: "Twenty minutes, zero preparation.", meta: "3 walkers" },
        { title: "A proper loop", detail: "One hour and somewhere to stop midway.", meta: "2 routes" },
        { title: "Take me somewhere", detail: "Let somebody else choose the direction.", meta: "Open invite" },
      ],
      cta: "start a wandering plan",
    };
    proposalTitle = "Start with radius, not destination";
    rationale = "Several ideas point to lowering the commitment. Distance is a clearer first choice than choosing a venue.";
  } else if (/food|meal|dinner|cook|market/.test(idea)) {
    app = {
      ...input.currentApp,
      eyebrow: "HUNGRY · THIS EVENING",
      headline: "How involved do you want dinner to be?",
      subheadline: "From shared leftovers to a full table, without appointing a planner.",
      accent: "coral",
      cards: [
        { title: "Bring what exists", detail: "No shopping. No shame. Combine the fridge.", meta: "3 kitchens" },
        { title: "Pick one place", detail: "A short list the room already agrees on.", meta: "2 favorites" },
        { title: "Make a night of it", detail: "Cook together and invite the wider orbit.", meta: "5 interested" },
      ],
      cta: "set the table",
    };
    proposalTitle = "Organize around effort, not cuisine";
    rationale = "The strongest shared constraint is how much work dinner should take. Let that determine the plan.";
  } else {
    app = {
      ...input.currentApp,
      headline: "What would make tonight feel easy?",
      subheadline: `The room’s latest signal: “${lastThought}”`,
      accent: "lime",
      cards: [
        { title: "Keep it familiar", detail: "A known place and people already nearby.", meta: "Fastest" },
        { title: "Change one thing", detail: "A small novelty without turning it into a project.", meta: "Room favorite" },
        { title: "Hand over the choice", detail: "Let the group pick and simply opt in.", meta: "Lowest effort" },
      ],
      cta: "make three easy plans",
    };
    proposalTitle = "Turn the latest thought into a choice";
    rationale = "The room has a useful new signal. This patch makes it concrete without expanding the product into another feed.";
  }

  return {
    mode: "demo",
    model: "local-demo",
    summary: `${proposalTitle}. I turned the room’s latest direction into three bounded choices and staged the result for a vote.`,
    app,
    changes: [
      "Reframed the opening question",
      "Converted discussion into three choices",
      "Kept the final action low-commitment",
    ],
    proposal: { title: proposalTitle, rationale },
    warning,
  };
}

function sanitizeResult(raw: unknown, input: GenerateBuildInput): Omit<BuildResult, "mode" | "model"> {
  const candidate = (raw && typeof raw === "object" ? raw : {}) as Partial<BuildResult>;
  const fallback = demoBuild(input);
  const rawChanges = Array.isArray(candidate.changes) ? candidate.changes : fallback.changes;
  const changes = rawChanges.slice(0, 3).map((change, index) =>
    text(change, fallback.changes[index] ?? "Refined the shared app", 90),
  );
  while (changes.length < 3) changes.push(fallback.changes[changes.length]);

  return {
    summary: text(candidate.summary, fallback.summary, 280),
    app: sanitizeApp(candidate.app, fallback.app),
    changes,
    proposal: {
      title: text(candidate.proposal?.title, fallback.proposal.title, 70),
      rationale: text(candidate.proposal?.rationale, fallback.proposal.rationale, 240),
    },
  };
}

export async function generateBuild(input: GenerateBuildInput): Promise<BuildResult> {
  const apiKey =
    process.env.MOONSHOT_API_KEY ??
    process.env.KIMI_API_KEY ??
    process.env.AI_API_KEY;

  if (!apiKey) {
    return demoBuild(input, "No model API key is configured, so this response used the deterministic demo engine.");
  }

  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/$/, "");
  const model = process.env.AI_MODEL ?? "kimi-k3";
  const thread = input.messages
    .slice(-20)
    .map((message) => `${message.author}: ${text(message.text, "", 700)}`)
    .join("\n");

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning_effort: "low",
        max_completion_tokens: 2400,
        messages: [
          {
            role: "system",
            content:
              "You are the synthesis engine inside make/room, a social product where a group's conversation becomes a useful app. Find the shared intent, preserve disagreements as constraints, and propose one coherent patch. Return only the requested structured result. Keep product copy concise, human, specific, and free of startup jargon. Never add an infinite feed, follower metrics, dark patterns, purchases, or unsafe executable code.",
          },
          {
            role: "user",
            content: `CURRENT SAFE APP SPEC\n${JSON.stringify(input.currentApp)}\n\nROOM THREAD\n${thread}\n\nLATEST DIRECTION\n${text(input.prompt, "Improve the app from the shared thread.", 1200)}\n\nCreate the next safe structured patch. Exactly three cards and exactly three change notes are required.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "make_room_patch",
            strict: true,
            schema: responseSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(55_000),
    });

    if (!response.ok) {
      throw new Error(`Provider returned ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("Provider returned no structured content");

    const result = sanitizeResult(JSON.parse(content), input);
    return { mode: "live", model, ...result };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Unknown provider error";
    return demoBuild(input, `The live model was unavailable (${reason}); the room stayed usable in demo mode.`);
  }
}
