# make/room

**The group chat that becomes an app.**

make/room is a working founder MVP for collective software creation. Signed-in people talk in a room, ask Kimi K3 to synthesize the shared direction into an app, vote on the staged build, publish it, and fork the result into a new room.

## What is real now

- ChatGPT identity at the application boundary
- durable invite-only rooms, memberships, messages, proposals, votes, versions, and forks in Cloudflare D1
- server-side Kimi K3 synthesis using the room's canonical message history
- an explicit staged-to-published approval flow with majority voting
- immutable published versions and independent fork histories
- generated scriptless single-page apps running in an opaque, network-blocked sandboxed iframe
- one in-flight synthesis per room plus per-user cooldown and daily founder limits
- honest failure states when Kimi is unavailable or not configured—there is no demo fallback

The generated-app boundary is intentionally narrow. Kimi generates HTML and CSS, including native interaction through `details`/`summary`, checkboxes, and radio state. The result is validated, size-limited, given a restrictive content security policy, and rendered without scripts, same-origin access, forms, storage, navigation, or network APIs. Arbitrary JavaScript, dependencies, and server-backed generated apps will require a separate isolated runner with enforced resource and egress limits.

## Run locally

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and set the model key on the server:

```bash
MOONSHOT_API_KEY=your_key_here
AI_BASE_URL=https://api.moonshot.ai/v1
AI_MODEL=kimi-k3
```

Never place the key in browser code or a `NEXT_PUBLIC_*` variable. For the hosted site, add `MOONSHOT_API_KEY` through the site's secret/environment settings rather than committing it or pasting it into chat. Without the key, collaboration still works and synthesis is visibly locked.

Local requests need the ChatGPT identity header supplied by the hosting environment. The automated tests exercise both authenticated and unauthenticated paths.

## Model boundary

[`lib/model-provider.ts`](lib/model-provider.ts) owns the replaceable provider integration. It sends only server-loaded room data to Kimi, requires a strict structured response, and does not trust messages supplied by the browser.

Kimi K3 is the initial quality baseline. As of July 22, 2026, the API model is available as `kimi-k3`; Moonshot says the weights and technical report will follow on July 27. Review the eventual weight license before self-hosting it commercially. Moonshot's current API terms also restrict products with potential competitive overlap without authorization, so production use should receive written commercial clearance.

Official references:

- [Kimi K3 API guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Kimi OpenPlatform terms](https://platform.kimi.ai/docs/agreement/modeluse)
- [Kimi Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk)

The direct HTTP integration is deliberate for this edge deployment; the Agent SDK expects process capabilities that are not available in a Cloudflare Worker.

## Commands

```bash
npm run dev      # local development
npm run build    # production build
npm test         # build plus product, API, and security checks
npm run lint     # source linting
```

## Next production layers

1. Expiring, scoped invitations plus explicit private/public room controls.
2. Configurable organization budgets and abuse controls beyond the fixed MVP limits.
3. A containerized build/test runner for generated projects with dependencies or backends.
4. Exportable source history and immutable commit attribution.
5. Public discovery based on useful shipped apps instead of an engagement feed.
