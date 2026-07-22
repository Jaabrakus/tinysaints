import type { GeneratedArtifact } from "./room-service";
import { assembleGeneratedArtifact } from "./starter-artifact";

export type ArtifactGenerationInput = {
  room: {
    id: string;
    name: string;
    note: string;
  };
  messages: Array<{
    author: string;
    body: string;
  }>;
  published: {
    name: string;
    version: number;
    html: string;
  };
};

export class ModelProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", enum: ["1"] },
    name: { type: "string", maxLength: 50 },
    proposalTitle: { type: "string", maxLength: 80 },
    rationale: { type: "string", maxLength: 320 },
    summary: { type: "string", maxLength: 320 },
    changes: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string", maxLength: 120 },
    },
    source: {
      type: "object",
      additionalProperties: false,
      properties: {
        html: {
          type: "string",
          description:
            "Body fragment only. No script, style, link, meta, base, iframe, object, embed, form, anchor tags, external assets, or inline event handlers.",
        },
        css: {
          type: "string",
          description:
            "CSS only. No @import, url(), external assets, or inline-style dependency. Use native details/summary, checkbox, and radio state for interaction.",
        },
      },
      required: ["html", "css"],
    },
  },
  required: [
    "schemaVersion",
    "name",
    "proposalTitle",
    "rationale",
    "summary",
    "changes",
    "source",
  ],
} as const;

function requireString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelProviderError(`Kimi returned an invalid ${field}.`, 502, "invalid_output");
  }
  return value.trim().slice(0, maxLength);
}

function validateResult(raw: unknown): Omit<GeneratedArtifact, "html"> & {
  source: { html: string; css: string };
} {
  if (!raw || typeof raw !== "object") {
    throw new ModelProviderError("Kimi returned an invalid artifact.", 502, "invalid_output");
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== "1") {
    throw new ModelProviderError("Kimi returned an unsupported artifact version.", 502, "invalid_output");
  }
  if (!value.source || typeof value.source !== "object") {
    throw new ModelProviderError("Kimi returned no artifact source.", 502, "invalid_output");
  }
  const source = value.source as Record<string, unknown>;
  const rawChanges = Array.isArray(value.changes) ? value.changes : [];
  if (rawChanges.length < 3 || rawChanges.length > 5) {
    throw new ModelProviderError("Kimi returned an invalid change list.", 502, "invalid_output");
  }

  return {
    name: requireString(value.name, "app name", 50),
    proposalTitle: requireString(value.proposalTitle, "proposal title", 80),
    rationale: requireString(value.rationale, "rationale", 320),
    summary: requireString(value.summary, "summary", 320),
    changes: rawChanges.map((change, index) =>
      requireString(change, `change ${index + 1}`, 120),
    ),
    source: {
      html: requireString(source.html, "HTML", 65_536),
      css: typeof source.css === "string" ? source.css.slice(0, 65_536) : "",
    },
  };
}

export async function generateArtifact(
  input: ArtifactGenerationInput,
): Promise<GeneratedArtifact> {
  const apiKey =
    process.env.MOONSHOT_API_KEY ??
    process.env.KIMI_API_KEY ??
    process.env.AI_API_KEY;
  if (!apiKey) {
    throw new ModelProviderError(
      "Kimi K3 is not configured yet. Add the server-side MOONSHOT_API_KEY secret to enable synthesis.",
      503,
      "model_not_configured",
    );
  }

  const model = process.env.AI_MODEL ?? "kimi-k3";
  const baseUrl = (process.env.AI_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/$/, "");
  const thread = input.messages
    .slice(-30)
    .map((message) => `${message.author}: ${message.body.slice(0, 1200)}`)
    .join("\n");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        reasoning_effort: "low",
        max_completion_tokens: 8_000,
        messages: [
          {
            role: "system",
            content:
              "You are Kimi inside make/room, where a real group's conversation becomes a small working web app. Synthesize the shared intent, disagreements, and constraints into one coherent patch. Return a scriptless, zero-network single-page artifact through the required JSON schema. HTML must be a body fragment with semantic elements and no forbidden tags, URLs, inline styles, or event handlers. CSS must be self-contained with no external assets. Create useful interaction with native details/summary elements or CSS state driven by accessible checkboxes and radio inputs; JavaScript is never allowed. Make the artifact responsive and specific to the room. Preserve useful parts of the published artifact, but do not merely restyle it. Never include secrets, analytics, purchases, dark patterns, follower counts, or an infinite feed. Return only the strict structured result.",
          },
          {
            role: "user",
            content: `ROOM\nName: ${input.room.name}\nPurpose: ${input.room.note}\n\nCANONICAL ROOM THREAD\n${thread}\n\nCURRENT PUBLISHED ARTIFACT · v${input.published.version}\n${input.published.html.slice(0, 80_000)}\n\nBuild the next version from the collective direction. Exactly 3–5 concise change notes are required.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "make_room_artifact",
            strict: true,
            schema: artifactSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ModelProviderError(
      timedOut
        ? "Kimi took too long to finish this build. Try synthesizing again."
        : "Kimi could not be reached. Try again in a moment.",
      503,
      timedOut ? "provider_timeout" : "provider_unavailable",
    );
  }

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;
    throw new ModelProviderError(
      response.status === 429
        ? "Kimi is at its current rate limit. Give the room a moment and retry."
        : "Kimi rejected this build request.",
      retryable ? 503 : 502,
      response.status === 429 ? "provider_rate_limited" : "provider_error",
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string;
      message?: { content?: string };
    }>;
    usage?: unknown;
  };
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== "stop") {
    throw new ModelProviderError(
      "Kimi did not finish the artifact cleanly. Try a narrower room direction.",
      502,
      "incomplete_output",
    );
  }
  const content = choice.message?.content;
  if (!content) {
    throw new ModelProviderError("Kimi returned no artifact.", 502, "empty_output");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ModelProviderError(
      "Kimi returned malformed structured output.",
      502,
      "invalid_json",
    );
  }

  const validated = validateResult(parsed);
  let html: string;
  try {
    html = assembleGeneratedArtifact(validated.source, validated.name);
  } catch (error) {
    throw new ModelProviderError(
      error instanceof Error ? error.message : "The generated artifact failed safety validation.",
      502,
      "unsafe_artifact",
    );
  }

  return {
    name: validated.name,
    proposalTitle: validated.proposalTitle,
    rationale: validated.rationale,
    summary: validated.summary,
    changes: validated.changes,
    html,
  };
}
