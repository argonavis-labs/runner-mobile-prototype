# runner-mobile-prototype

V0 prototype for Runner mobile — a text-based companion that puts your Runner agent in iMessage.

## Repo layout

```
apps/
  microsite/        # Vite + React onboarding SPA
  server/           # Express + Spectrum runtime (inbound + link mint + cron tick)
  cron/             # Railway cron job — HTTP-pokes the server
packages/shared/
  db/               # Drizzle schema, migrations, pg client
  runner-api/       # Typed client for Runner backend (auth, catalog, MCP URL)
  managed-agents/   # Claude Managed Agents wrapper, send_imessage tool, turn loop
  spectrum/         # spectrum-ts wrapper (inbound consume + outbound send)
```

Stack: pnpm workspaces, TypeScript via tsx (no precompile step), Postgres, Drizzle, Express, Vite + React, `@anthropic-ai/sdk` beta managed-agents, `spectrum-ts`.

## Local dev

```bash
docker compose up -d postgres
cp .env.example .env       # fill in real values
pnpm install
pnpm db:migrate
pnpm dev:server            # :3001
pnpm dev:microsite         # :5173
```

For end-to-end testing, expose the server via ngrok / Cloudflare tunnel so Spectrum's cloud can reach it.

## Production (Railway)

`railway.toml` defines three services (server, microsite, cron) plus a Postgres plugin. Set env vars per-service from `.env.example`. Cron runs every 15 min and POSTs `/api/cron/tick` with `CRON_SHARED_SECRET`.

## What is Runner?

Runner is a multi-session AI agent inbox — a desktop app (Electron + React) that lets you run, organize, and automate Claude-powered (and Codex-powered) sessions across connected apps. Sessions live in workspaces with a Todo / In Progress / Needs Review / Done workflow, plus flagging, dynamic statuses, and skills.

Each workspace can connect to:
- **Composio integrations** (~35) — Gmail, Calendar, Slack, GitHub, HubSpot, Salesforce, Asana, Airtable, Outlook, Pipedrive, QuickBooks, Klaviyo, etc. Auth and tokens live server-side in Composio.
- **First-party MCP servers** (~10) — Notion, Linear, Miro, Mixpanel, Granola, Omni, Otter, Logfire, Grain, Fellow, Amplemarket. Backend brokers OAuth and proxies MCP calls with token injection.
- **Unipile** — LinkedIn, Instagram. Currently client-side only.
- **Local sources** (macOS-only) — iMessage, Apple Notes, filesystem.

Backend on GCP / Cloud SQL. Sign-in via WorkOS AuthKit (Google + Magic Auth). Published under **ArgoNavis Inc. / argonavis-labs** with bundle prefix `now.runner.*`.

Sibling repo: `/Users/yitongzhang/src/runner/` (the desktop monorepo). This prototype is **separate** — it's the V0 mobile companion, not yet integrated.

## TL;DR

The first version of Runner mobile is a text-based companion. It accesses your existing connected apps, but has **no awareness of your other (desktop) sessions**. Two purposes:

- **P0:** Onboard and wow people who aren't at their laptop right now (conference attendees)
- **P1:** Act as a mobile companion for existing Runner desktop users

There's a chance this is all the mobile we'll ever need.

## Timeline

Working backward from **May 12, 2026** — a conference of ops leaders we're sponsoring. Mobile must be live by then.

## Principles

1. Ship a fast, small MVP and iterate. Acceptable to be a mostly-disconnected companion with no shared session state with desktop.
2. Lean into messaging as the mobile UI. No install. No app store approval.
3. Work backward from May 12. Cut whatever scope is necessary to land reliably.

---

## Product plan

### The pitch

**A landing page that gives you a smart agent in your iMessage, in under a minute, with no app to install — and your full Runner workspace in your pocket.**

### Onboarding microsite (new mobile-web app)

Single page, two paths driven by whether the email already has a Runner account.

**Path A — Existing user (most likely at the conference)**
1. Magic Auth: email → 6-digit code → JWT
2. Backend recognizes existing `user_id`; `GET /api/v1/catalog?workspaceId=X` returns connected apps
3. **Skip connection step.** Page shows: *"Welcome back. We see Gmail, HubSpot, Linear, Notion, Calendar connected. Tap to text Runner."*
4. iMessage handoff (`imessage:` link with prefilled "hi 👋")

**Path B — New user**
1. Magic Auth → creates Runner account (same `userAuthFinalizeUseCase` as desktop)
2. Catalog rendered dynamically from `GET /api/v1/catalog` — full list, with logos
3. User connects ≥1 integration via existing `POST /api/v1/connect` (Composio's mobile-friendly hosted OAuth)
4. iMessage handoff

### iMessage conversation

- Bidirectional via Spectrum (`spectrum-ts`). SMS auto-fallback on Android — no extra code.
- One persistent Claude Managed Agents session per user, keyed by phone number. Memory survives across messages via the harness's persistent filesystem.
- Agent inherits **every Composio + MCP-OAuth integration** the user has connected, transparently. First reply can already reference real calendar/inbox/tickets.
- Web search + fetch built in via the Managed Agents harness for everything outside connectors.

### Heartbeat (proactivity)

- Cron every **15 minutes**
- For each user with no inbound message in 4h+, poke their session with a `[heartbeat tick]` event
- Agent decides whether to text — most ticks are no-ops
- **No cap** on proactive messages per day (we'll learn from the logs)
- **Quiet hours: 9a–8p ET** (hard-coded)

### System prompt

Minimum. Identity + tone only. We trust the model and adjust based on conference feedback:

> *"You're Runner, an assistant texting via iMessage. You have access to the apps the user has connected. Be helpful and natural. Replies short by default."*

---

## Architecture

### Auth — reuse existing endpoints, zero backend changes

| Step | Endpoint |
|---|---|
| Send code to email | `POST /auth/magic-auth/start { email }` |
| Verify code → JWT + refresh token | `POST /auth/magic-auth/verify { email, code }` |
| Refresh JWT | `POST /auth/refresh` |

Email is the canonical Runner identity. A mobile sign-up auto-merges with any existing desktop account by email via the shared `userAuthFinalizeUseCase`.

### Connectors — reuse existing MCP endpoints, zero backend changes

The runtime path is uniform across Composio and first-party MCP integrations:

```
GET  /api/v1/catalog?workspaceId={id}   → list of connections + status
POST /api/v1/connect { slug, workspaceId } → Composio OAuth redirect URL
POST /mcp/{workspaceId}/{slug}          → JWT-authed MCP endpoint per integration
```

At session-spawn time:

```ts
mcpServers: connections.map(c => ({
  url: `${RUNNER_BACKEND}/mcp/${workspaceId}/${c.slug}`,
  headers: { Authorization: `Bearer ${jwt}` }
}))
```

Backend handles all token refresh, OAuth quirks, Composio plumbing, MCP-server proxying. Agent doesn't know which type is which.

### Excluded from V0

- **Unipile** (LinkedIn, Instagram) — currently client-side architecture; would need a backend Unipile-as-MCP wrapper. Skip; tell users "desktop-only for now."
- **Local macOS sources** (iMessage, Apple Notes) — physically impossible from a cloud Managed Agents container. Permanently skip on mobile.

### Runtime topology

```
iMessage (Spectrum) ──→ Spectrum webhook
                              │
                              ▼
                       Express handler (Railway)
                              │
                       ┌──────┴──────┐
                       │             │
                  Postgres lookup    │
                  (phone → user)     │
                              │      │
                              ▼      │
              Claude Managed Agents session (per user)
                              │
                       MCP servers ──→ runner backend /mcp/.../* 
                                           │
                                       Composio / first-party MCP
                              │
                              ▼
                       Agent reply via Spectrum
```

Heartbeat cron (Railway) walks idle users every 15 min and pokes their session with a tick event. Agent decides whether to text.

### Prototype's own data model

Tiny Postgres on Railway:

```sql
users (
  phone_number   text primary key,
  runner_user_id text not null,
  workspace_id   text not null,
  jwt            text not null,
  refresh_token  text not null,
  jwt_expires_at timestamptz,
  last_user_msg_at timestamptz,
  last_assistant_msg_at timestamptz
)
```

That's it. All other state lives in the Managed Agents session FS or in Runner's existing backend.

---

## Tech stack

| Layer | Choice |
|---|---|
| Agent runtime | **Claude Managed Agents** (hosted harness, beta `managed-agents-2026-04-01`) |
| App infra (microsite, webhooks, cron, DB) | **Railway** (Postgres + Node services) |
| iMessage / SMS | **Photon Spectrum** (`spectrum-ts`) |
| Microsite | Next.js or Vite + React (TBD, low-stakes) |

---

## Feature list (final)

| Feature | Status |
|---|---|
| Magic Auth sign-in (email + 6-digit code) | ✅ V0 |
| Microsite renders full integration catalog dynamically | ✅ V0 |
| In-microsite connect flow via `POST /api/v1/connect` | ✅ V0 |
| Existing users skip connection step | ✅ V0 |
| iMessage thread per user (Spectrum); SMS fallback Android | ✅ V0 |
| Persistent Managed Agents session per phone number | ✅ V0 |
| Agent inherits all Composio + MCP-OAuth integrations | ✅ V0 |
| Heartbeat cron 15-min, no cap, 9a–8p ET | ✅ V0 |
| Minimum system prompt | ✅ V0 |
| Unipile integrations (LinkedIn, IG) | ❌ V0 — desktop-only |
| Local macOS sources | ❌ Mobile-impossible |
| Shared session state with desktop | ❌ V0 |
| Memory cloud-sync between desktop and mobile | ❌ V0 |
| Double-heartbeat coordination | ❌ V0 |
| Haiku ack pattern | ❌ V0 |
| Usage tracking on user's Runner quota | ❌ V0 (we eat inference cost) |
| Desktop-install nudge from mobile agent | ❌ V0 |

## Net backend surgery: **zero**

Everything reuses existing endpoints (`/auth/magic-auth/*`, `/auth/refresh`, `/api/v1/workspaces`, `/api/v1/catalog`, `/api/v1/connect`, `/mcp/{workspaceId}/{slug}`).

---

## Open questions for v1+

- **Double heartbeat:** if user has both desktop and mobile, do they get heartbeats from both?
- **Memory sync:** cloud-replicate personal memories so mobile and desktop sessions share context?
- **Mobile-active proactivity gate:** turn off mobile heartbeat when desktop is on?
- **Inference billing:** route through `proxy.runner.now` so mobile usage counts against user's Runner quota?
- **Phone-as-identity:** add a `users.phone_number` column to runner backend, skip the email step entirely?
- **Unipile on mobile:** wrap Unipile as a backend MCP server so LinkedIn/IG work in mobile?
