import { NextResponse } from "next/server";
import {
  generateBuild,
  type AppSpec,
  type GenerateBuildInput,
} from "../../../lib/model-provider";

export const runtime = "edge";

const fallbackApp: AppSpec = {
  name: "tiny plans",
  eyebrow: "TONIGHT · WITHIN 2 MILES",
  headline: "What kind of night do you need?",
  subheadline: "Three good options. No feed, no planning spiral.",
  accent: "lime",
  cards: [
    { title: "Low-key", detail: "Tea, a walk, somewhere quiet.", meta: "4 nearby" },
    { title: "Move around", detail: "Something active without a big plan.", meta: "2 plans" },
    { title: "Surprise me", detail: "Let the room pick one unusual thing.", meta: "Open" },
  ],
  cta: "show me three plans",
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Partial<GenerateBuildInput>;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim().slice(0, 1200) : "";
    const messages = Array.isArray(body.messages)
      ? body.messages
          .slice(-20)
          .filter(
            (message): message is { author: string; text: string } =>
              Boolean(
                message &&
                  typeof message.author === "string" &&
                  typeof message.text === "string",
              ),
          )
          .map((message) => ({
            author: message.author.slice(0, 60),
            text: message.text.slice(0, 700),
          }))
      : [];

    if (!prompt && messages.length === 0) {
      return NextResponse.json(
        { error: "Add at least one room message before synthesizing." },
        { status: 400 },
      );
    }

    const currentApp =
      body.currentApp && typeof body.currentApp === "object"
        ? (body.currentApp as AppSpec)
        : fallbackApp;

    const result = await generateBuild({ prompt, messages, currentApp });
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "That room update could not be read." },
      { status: 400 },
    );
  }
}
