import {
  createGuestSession,
  GUEST_COOKIE_NAME,
  revokeGuestSession,
  RoomError,
} from "../../../lib/room-service";

export const runtime = "edge";

function cookieHeader(token: string, request: Request, maxAge: number) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${GUEST_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function requestCookie(request: Request) {
  const source = request.headers.get("cookie") ?? "";
  for (const pair of source.split(";")) {
    const [name, ...value] = pair.trim().split("=");
    if (name === GUEST_COOKIE_NAME) return value.join("=");
  }
  return "";
}

export async function POST(request: Request) {
  try {
    const site = request.headers.get("sec-fetch-site");
    if (site && site !== "same-origin" && site !== "same-site" && site !== "none") {
      throw new RoomError("Cross-site guest sessions are not allowed.", 403);
    }
    if (!request.headers.get("content-type")?.includes("application/json")) {
      throw new RoomError("Use a JSON guest-session request.", 415);
    }
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 2_000) throw new RoomError("That guest request is too large.", 413);
    const payload = (await request.json()) as { displayName?: string };
    const session = await createGuestSession(payload.displayName ?? "");
    return Response.json(
      { user: { displayName: session.identity.displayName } },
      {
        status: 201,
        headers: {
          "set-cookie": cookieHeader(session.token, request, 60 * 60 * 24 * 30),
          "cache-control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof RoomError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Guest session failed", error);
    return Response.json({ error: "The guest workspace could not start." }, { status: 500 });
  }
}

export async function GET(request: Request) {
  await revokeGuestSession(requestCookie(request));
  return new Response(null, {
    status: 302,
    headers: {
      location: new URL("/", request.url).toString(),
      "set-cookie": cookieHeader("", request, 0),
      "cache-control": "no-store",
    },
  });
}
