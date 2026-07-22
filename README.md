# make/room

**The group chat that becomes an app.**

This repository is the first working proof of the product idea: a small group talks through an idea, an AI synthesis engine turns the shared direction into a bounded app patch, the room previews and backs it, and the result can be shipped or forked.

## What the prototype proves

- a persistent-feeling room with makers, messages, and lightweight presence
- collective synthesis instead of a one-person prompt box
- a visible proposal with rationale, change notes, and votes
- a staged app preview that stays separate from the published version
- shipping, version history, and a fork interaction
- a safe structured-spec boundary between the model and the rendered app
- a live Kimi K3 path with a deterministic no-key demo fallback

The current preview intentionally renders model output through a constrained `AppSpec`; it does not execute arbitrary generated code. The next engineering layer should run free-form code in isolated sandboxes with explicit permissions, diffs, tests, and approval gates.

## Run it

Node.js 22.13 or newer is required.

```bash
npm install
npm run dev
```

Open the local URL printed by the development server. The room works immediately in demo mode.

To enable live Kimi synthesis, copy `.env.example` to `.env.local` and set a server-side key:

```bash
MOONSHOT_API_KEY=your_key_here
AI_BASE_URL=https://api.moonshot.ai/v1
AI_MODEL=kimi-k3
```

Never put the model key in `app/page.tsx` or any `NEXT_PUBLIC_*` variable. The browser calls `/api/generate`; only the server contacts the model provider.

## Model boundary

`lib/model-provider.ts` owns the provider integration. It uses the OpenAI-compatible Chat Completions shape, so the collaboration, voting, versioning, and fork graph remain independent from Kimi.

Kimi K3 is the preferred quality baseline. As of July 22, 2026, it is available through the Kimi API as `kimi-k3`, but its full weights and accompanying technical report are promised for July 27 and are not yet available to self-host. The eventual weight license must be reviewed before treating it as a commercial open-weight dependency.

Moonshot's current API terms permit customer applications but restrict products with potential competitive overlap without authorization. Because make/room overlaps some Kimi Code and Kimi Work capabilities, production use of the direct API should receive written commercial clearance. Keeping the provider boundary replaceable is intentional.

Official references:

- [Kimi K3 API guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart)
- [Kimi K3 launch notes](https://www.kimi.com/blog/kimi-k3)
- [Kimi OpenPlatform terms](https://platform.kimi.ai/docs/agreement/modeluse)
- [Kimi Agent SDK](https://github.com/MoonshotAI/kimi-agent-sdk)

## Commands

```bash
npm run dev      # local development
npm run build    # production build
npm test         # build plus rendered product/API checks
npm run lint     # source linting
```

## Product architecture after this proof

1. Add identity, durable rooms, message history, and proposal records.
2. Move code generation into isolated per-fork workspaces.
3. Store each accepted patch as an immutable commit with attribution.
4. Run generated builds and tests before exposing a preview URL.
5. Add room permissions, secret scoping, abuse controls, and compute budgets.
6. Introduce public discovery only through apps people actually use—not an engagement feed.
