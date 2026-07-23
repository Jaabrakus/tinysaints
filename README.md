# make/room

**The group chat that becomes an app.**

make/room is a working founder MVP for collective software creation. Signed-in people talk in a room, edit a shared source tree or ask Kimi K3 to synthesize the direction, review the exact diff, vote on the staged build, publish it, and fork the result into a new room.

## What is real now

- ChatGPT identity at the application boundary
- durable invite-only rooms, memberships, messages, proposals, votes, versions, and forks in Cloudflare D1
- server-side Kimi K3 synthesis using the room's canonical message history
- a bounded multi-file project tree with folders, optimistic conflict protection, and immutable whole-project snapshots
- browser JavaScript through a nonce-scoped, opaque sandbox with storage, navigation, workers, and network access blocked
- immutable source snapshots and a line-by-line review diff on every manual or Kimi proposal
- an explicit staged-to-published approval flow with majority voting
- immutable published versions, independent fork histories, and fork-to-parent merge proposals
- safe three-way convergence: different files combine automatically while overlapping file edits stop as conflicts
- fork presentations that expose an explicitly presented published build to the parent room without exposing the fork's private working history
- a device-local Ollama adapter that proposes the active file under the signed-in maker's identity and never sends the local endpoint to the room
- one in-flight synthesis per room plus per-user cooldown and daily founder limits
- honest failure states when Kimi is unavailable or not configured—there is no demo fallback
- an optional protected Core Studio release bridge that turns a majority-backed published room snapshot into a GitHub commit, letting the connected host deploy without a manual Git push

The generated-app boundary is intentionally narrow. Kimi still generates validated HTML and CSS. Makers and their personal local agents may also edit a bounded `src/app.js` entry file and add supporting text files in folders. JavaScript runs in an opaque iframe with no same-origin access, storage, workers, forms, navigation, or network APIs. Package installation, imported dependencies, and server-backed generated apps still require a separate isolated runner with enforced resource and egress limits.

Room state refreshes every two seconds while the page is visible. That gives the team fast shared state and presence for the MVP, but it is not a CRDT editor, shared cursor system, or synchronized remote browser session.

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

## Protected Core Studio

An existing room becomes the self-hosting Make/Room Core Studio when its slug matches the server-only `CORE_ROOM_SLUG`. Configure `GITHUB_RELEASE_REPOSITORY`, `GITHUB_RELEASE_BRANCH`, and a narrowly scoped `GITHUB_RELEASE_TOKEN` with repository Contents read/write permission. Set `CORE_VALIDATION_WORKFLOW=core-validation.yml` and grant Actions write permission to dispatch isolated checks for every proposal branch. The Core repository workspace reads the real source tree, edits files in Monaco, creates a unique `make-room/proposal-*` branch without a local Git client, and records the branch as a shared room contribution. Promotion requires “useful” backing from a majority of room members, re-checks that the reviewed branch still points to the exact recorded commit, requires the room owner, and advances the protected branch only through a non-force fast-forward. A Vercel, Cloudflare, or other Git-connected host can deploy that commit automatically.

The bridge deliberately does not bypass review: collaborators create parallel repository proposals, run checks, inspect them, and back the version they want before promotion. Git remains the audit and rollback layer even though contributors do not operate Git themselves.

Local requests need the ChatGPT identity header supplied by the hosting environment. The automated tests exercise both authenticated and unauthenticated paths.

## Model boundary

[`lib/model-provider.ts`](lib/model-provider.ts) owns the replaceable provider integration. It sends only server-loaded room data to Kimi, requires a strict structured response, and does not trust messages supplied by the browser.

The Code workspace also includes a personal-agent panel for a maker's local Ollama server. The endpoint and model preference remain in that browser. Ollama receives only the active file and the maker's instruction; the room receives only the completed file proposal, agent label, immutable source snapshot, and review diff. Local browser access may require configuring Ollama to allow the hosted site's origin.

The adapter uses Ollama's documented local [`POST /api/chat`](https://docs.ollama.com/api/chat) endpoint and [JSON-schema structured outputs](https://docs.ollama.com/capabilities/structured-outputs).

Kimi K3 is the initial quality baseline. As of July 22, 2026, the API model is available as `kimi-k3`; Moonshot says the weights and technical report will follow on July 27. Review the eventual weight license before self-hosting it commercially. Moonshot's current API terms also restrict products with potential competitive overlap without authorization, so production use should receive written commercial clearance.

Official references:

- [Kimi K3 API guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Kimi OpenPlatform terms](https://platform.kimi.ai/docs/agreement/modeluse)
- [Kimi Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk)

The direct HTTP integration is deliberate for this edge deployment; the Agent SDK expects process capabilities that are not available in a Cloudflare Worker.

## Kimi Code adaptation

This project adapts the bounded line-diff primitive and the chat-first pane hierarchy from the MIT-licensed [MoonshotAI/kimi-code](https://github.com/MoonshotAI/kimi-code) repository. It keeps make/room's own visual identity and does not copy Kimi branding or transplant the local daemon, terminal, filesystem, or process runner into the edge worker. Those capabilities require a separately isolated runtime.

The collaborative spin is native to make/room: source edits become immutable room proposals, every proposal has a reviewable diff, active votes attach to that exact snapshot, shipping is guarded by majority backing, and forks copy only the published source tree. A contributor can publish work in a fork and propose it back to the immediate parent; non-overlapping file changes converge into one staged snapshot, while overlapping file edits leave both rooms untouched until a person resolves the conflict. See [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for the pinned upstream commit and full MIT notice.

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
3. A containerized build/test runner for imported dependencies and controlled server functions.
4. A real-time room channel plus presenter/follower preview state.
5. Exportable Git repositories and signed commit attribution.
6. CRDT/live-cursor editing after the parallel-branch collaboration model proves useful.
7. Public discovery based on useful shipped apps instead of an engagement feed.
