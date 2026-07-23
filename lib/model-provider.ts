import type { GeneratedArtifact } from "./room-service";
import type { ProjectChange } from "./convergence";
import {
  assembleGeneratedArtifact,
  sourceFilesFromGenerated,
  type ArtifactSourceFile,
} from "./starter-artifact";

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
  current: {
    name: string;
    version: number;
    files: ArtifactSourceFile[];
  };
};

export type ConvergenceGenerationInput = {
  room: { name: string; note: string };
  messages: Array<{ author: string; body: string }>;
  current: { version: number; files: ArtifactSourceFile[] };
  branches: Array<{
    name: string;
    ownerName: string;
    version: number;
    changes: ProjectChange[];
  }>;
  instruction?: string;
};

export type ProjectAgentInput = {
  room: { name: string; note: string };
  messages: Array<{ author: string; body: string }>;
  current: { version: number; files: ArtifactSourceFile[] };
  instruction: string;
};

export type ConvergenceProposal = {
  proposalTitle: string;
  rationale: string;
  summary: string;
  changes: string[];
  patches: ProjectChange[];
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

function providerConfig() {
  const apiKey = process.env.MOONSHOT_API_KEY ?? process.env.KIMI_API_KEY ?? process.env.AI_API_KEY;
  const allowUnauthenticated = process.env.AI_ALLOW_UNAUTHENTICATED === "true";
  if (!apiKey && !allowUnauthenticated) {
    throw new ModelProviderError(
      "The shared model is not configured. Add AI_BASE_URL, AI_MODEL, and an API key—or explicitly allow a trusted unauthenticated self-hosted endpoint.",
      503,
      "model_not_configured",
    );
  }
  return {
    apiKey,
    model: process.env.AI_MODEL ?? "kimi-k2.5",
    baseUrl: (process.env.AI_BASE_URL ?? "https://api.moonshot.ai/v1").replace(/\/$/, ""),
  };
}

function providerHeaders(apiKey: string | undefined) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return headers;
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

const convergenceSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    schemaVersion: { type: "string", enum: ["1"] },
    proposalTitle: { type: "string", maxLength: 100 },
    rationale: { type: "string", maxLength: 500 },
    summary: { type: "string", maxLength: 320 },
    changes: {
      type: "array",
      minItems: 3,
      maxItems: 12,
      items: { type: "string", maxLength: 140 },
    },
    patches: {
      type: "array",
      minItems: 1,
      maxItems: 40,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", maxLength: 120 },
          operation: { type: "string", enum: ["upsert", "delete"] },
          content: { type: "string", maxLength: 65_536 },
        },
        required: ["path", "operation", "content"],
      },
    },
  },
  required: ["schemaVersion", "proposalTitle", "rationale", "summary", "changes", "patches"],
} as const;

function requireString(value: unknown, field: string, maxLength: number) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ModelProviderError(`Kimi returned an invalid ${field}.`, 502, "invalid_output");
  }
  return value.trim().slice(0, maxLength);
}

function validateResult(raw: unknown): Omit<GeneratedArtifact, "html" | "files"> & {
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
  const { apiKey, model, baseUrl } = providerConfig();
  const thread = input.messages
    .slice(-30)
    .map((message) => `${message.author}: ${message.body.slice(0, 1200)}`)
    .join("\n");

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: providerHeaders(apiKey),
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
            content: `ROOM\nName: ${input.room.name}\nPurpose: ${input.room.note}\n\nCANONICAL ROOM THREAD\n${thread}\n\nCURRENT SOURCE SNAPSHOT · v${input.current.version}\n${input.current.files
              .map((file) => `--- ${file.path} ---\n${file.content}`)
              .join("\n\n")
              .slice(0, 120_000)}\n\nReturn complete replacements for index.html and styles.css through the required source fields. Build the next version from the collective direction. Exactly 3–5 concise change notes are required.`,
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
    files: sourceFilesFromGenerated(validated.source),
  };
}

export async function generateConvergencePatch(
  input: ConvergenceGenerationInput,
): Promise<ConvergenceProposal> {
  const { apiKey, model, baseUrl } = providerConfig();
  const thread = input.messages
    .slice(-30)
    .map((message) => `${message.author}: ${message.body.slice(0, 1200)}`)
    .join("\n");
  const currentSource = input.current.files
    .map((file) => `--- ${file.path} ---\n${file.content}`)
    .join("\n\n")
    .slice(0, 110_000);
  const forkSource = input.branches
    .map((branch) => {
      const changes = branch.changes.map((change) =>
        change.content === null
          ? `--- DELETE ${change.path} ---`
          : `--- UPSERT ${change.path} ---\n${change.content}`,
      ).join("\n\n");
      return `FORK: ${branch.ownerName} · ${branch.name} · v${branch.version}\n${changes}`;
    })
    .join("\n\n===== NEXT PRESENTED FORK =====\n\n")
    .slice(0, 130_000);
  const isDirectProjectTask = input.branches.length === 0 && Boolean(input.instruction?.trim());

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: providerHeaders(apiKey),
      body: JSON.stringify({
        model,
        reasoning_effort: "low",
        max_completion_tokens: 12_000,
        messages: [
          {
            role: "system",
            content:
              isDirectProjectTask
                ? "You are the shared whole-project coding agent inside make/room. Read every project file and the recent room conversation, follow the direct task, and return the smallest coherent multi-file patch that completes it. A patch is a complete file replacement or deletion, never a diff. Preserve the project's runtime and package choices. Do not publish: your result becomes one proposal humans inspect, back, and ship. Keep index.html and styles.css. Do not add secrets, external network calls, unsafe JavaScript capabilities, analytics, purchases, or hidden behavior. Return only the strict structured result."
                : "You are the convergence agent inside make/room. Compare every explicitly presented team fork against the main room's current project. Preserve compatible contributions, reconcile overlapping ideas using the canonical room conversation, and return the smallest coherent multi-file patch that advances the shared product. A patch is a complete file replacement or deletion, never a diff. Do not publish: your result becomes one proposal humans must inspect, back, and ship. Keep index.html and styles.css. Do not add secrets, external network calls, unsafe JavaScript capabilities, analytics, purchases, or hidden behavior. Return only the strict structured result.",
          },
          {
            role: "user",
            content: isDirectProjectTask
              ? `PROJECT\nName: ${input.room.name}\nPurpose: ${input.room.note}\n\nDIRECT TASK\n${input.instruction?.trim().slice(0, 2_000)}\n\nRECENT ROOM THREAD\n${thread}\n\nCOMPLETE CURRENT PROJECT · v${input.current.version}\n${currentSource}\n\nReturn one reviewable multi-file patch that completes the direct task. For delete operations, content must be an empty string.`
              : `MAIN ROOM\nName: ${input.room.name}\nPurpose: ${input.room.note}\n\nCANONICAL ROOM THREAD\n${thread}\n\nCURRENT MAIN PROJECT · v${input.current.version}\n${currentSource}\n\nPRESENTED FORK CHANGES\n${forkSource}\n\nReturn one integrated patch. Mention which forks or ideas were combined in the change notes. For delete operations, content must be an empty string.`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "make_room_convergence",
            strict: true,
            schema: convergenceSchema,
          },
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ModelProviderError(
      timedOut
        ? "The convergence agent took too long. Present fewer or smaller forks and try again."
        : "The convergence agent could not be reached. Try again in a moment.",
      503,
      timedOut ? "provider_timeout" : "provider_unavailable",
    );
  }
  if (!response.ok) {
    throw new ModelProviderError(
      response.status === 429
        ? "The convergence agent is at its current rate limit. Try again shortly."
        : "The convergence model rejected this comparison.",
      response.status === 429 || response.status >= 500 ? 503 : 502,
      response.status === 429 ? "provider_rate_limited" : "provider_error",
    );
  }
  const payload = (await response.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
  };
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== "stop" || !choice.message?.content) {
    throw new ModelProviderError(
      "The convergence agent did not finish a complete proposal.",
      502,
      "incomplete_output",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(choice.message.content);
  } catch {
    throw new ModelProviderError("The convergence agent returned malformed output.", 502, "invalid_json");
  }
  if (!raw || typeof raw !== "object") {
    throw new ModelProviderError("The convergence agent returned an invalid proposal.", 502, "invalid_output");
  }
  const value = raw as Record<string, unknown>;
  if (value.schemaVersion !== "1" || !Array.isArray(value.changes) || !Array.isArray(value.patches)) {
    throw new ModelProviderError("The convergence agent returned an invalid proposal.", 502, "invalid_output");
  }
  if (value.changes.length < 3 || value.changes.length > 12 || value.patches.length < 1 || value.patches.length > 40) {
    throw new ModelProviderError("The convergence proposal exceeded its safety bounds.", 502, "invalid_output");
  }
  const seenPaths = new Set<string>();
  const patches = value.patches.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new ModelProviderError(`Convergence patch ${index + 1} is invalid.`, 502, "invalid_output");
    }
    const patch = entry as Record<string, unknown>;
    const path = requireString(patch.path, `patch ${index + 1} path`, 120);
    if (seenPaths.has(path)) {
      throw new ModelProviderError(`The convergence agent changed ${path} twice.`, 502, "invalid_output");
    }
    seenPaths.add(path);
    if (patch.operation !== "upsert" && patch.operation !== "delete") {
      throw new ModelProviderError(`Convergence patch ${index + 1} has an invalid operation.`, 502, "invalid_output");
    }
    if (typeof patch.content !== "string") {
      throw new ModelProviderError(`Convergence patch ${index + 1} has invalid content.`, 502, "invalid_output");
    }
    return { path, content: patch.operation === "delete" ? null : patch.content.slice(0, 65_536) };
  });
  return {
    proposalTitle: requireString(value.proposalTitle, "proposal title", 100),
    rationale: requireString(value.rationale, "rationale", 500),
    summary: requireString(value.summary, "summary", 320),
    changes: value.changes.map((change, index) => requireString(change, `change ${index + 1}`, 140)),
    patches,
  };
}

export async function generateProjectPatch(input: ProjectAgentInput) {
  if (!input.instruction.trim()) {
    throw new ModelProviderError("Give the project AI a concrete task.", 400, "missing_instruction");
  }
  return generateConvergencePatch({
    room: input.room,
    messages: input.messages,
    current: input.current,
    branches: [],
    instruction: input.instruction,
  });
}
