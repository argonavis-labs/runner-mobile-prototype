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
3. **Skip connection step.** Page shows: _"Welcome back. We see Gmail, HubSpot, Linear, Notion, Calendar connected. Tap to text Runner."_
4. iMessage handoff (`imessage:` link with prefilled "hi 👋")

**Path B — New user**

1. Magic Auth → creates Runner account (same `userAuthFinalizeUseCase` as desktop)
2. Catalog rendered dynamically from `GET /api/v1/catalog` — full list, with logos
3. User connects ≥1 integration via existing `POST /api/v1/connect` (Composio's mobile-friendly hosted OAuth)
4. iMessage handoff

### iMessage conversation

- Bidirectional via Spectrum (`spectrum-ts`). SMS auto-fallback on Android — no extra code.
- One persistent Claude Managed Agents session per user, keyed by phone number. V0 session continuity comes from the Managed Agents session; durable cross-desktop/mobile memory is a separate design below.
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

> _"You're Runner, an assistant texting via iMessage. You have access to the apps the user has connected. Be helpful and natural. Replies short by default."_

---

## Architecture

### Auth — reuse existing endpoints, zero backend changes

| Step                              | Endpoint                                       |
| --------------------------------- | ---------------------------------------------- |
| Send code to email                | `POST /auth/magic-auth/start { email }`        |
| Verify code → JWT + refresh token | `POST /auth/magic-auth/verify { email, code }` |
| Refresh JWT                       | `POST /auth/refresh`                           |

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
mcpServers: connections.map((c) => ({
  url: `${RUNNER_BACKEND}/mcp/${workspaceId}/${c.slug}`,
  headers: { Authorization: `Bearer ${jwt}` },
}));
```

Backend handles all token refresh, OAuth quirks, Composio plumbing, MCP-server proxying. Agent doesn't know which type is which.

### Cloud memory replica — prototype-owned, zero Runner backend changes

The mobile companion needs to share personal memory with desktop/local agents, but Runner desktop memory is currently local-first. Do not make the managed-agent container filesystem or Anthropic Memory Stores the canonical store for this product. Instead, the prototype owns a cloud-backed **virtual memory directory** in its own Postgres database and mirrors that directory to/from the user's Mac.

The memory shape should intentionally match Claude Code's agent-memory apparatus:

```
runner-mobile-cloud/
  MEMORY.md
  user_profile.md
  collaboration_preferences.md
  runner_workflows.md
```

`MEMORY.md` is the entrypoint and index. It is loaded into the mobile agent's context when the agent/session is prepared. It is not where memory bodies live. Each entry should be a short pointer:

```markdown
- [Collaboration preferences](collaboration_preferences.md) — response style and workflow preferences
```

Each topic file is a markdown memory with frontmatter:

```markdown
---
name: Collaboration preferences
description: How the user likes agents to communicate and execute work
type: feedback
---

The user prefers direct execution for operational requests.

**Why:** Repeated back-and-forth is costly when the machine already has enough context.
**How to apply:** If a task can be done and verified locally, do it before reporting back.
```

Memory types follow the Claude Code taxonomy:

- `user`: user's role, goals, responsibilities, and durable personal context.
- `feedback`: guidance on how the agent should behave, including corrections and validated preferences.
- `project`: non-derivable context about ongoing work, deadlines, decisions, or incidents.
- `reference`: pointers to external systems and where to find up-to-date information.

The mobile agent gets explicit memory-directory tools rather than generic fact CRUD:

| Tool                                         | Purpose                                                 |
| -------------------------------------------- | ------------------------------------------------------- |
| `read_memory_file(path)`                     | Read `MEMORY.md` or a topic memory file.                |
| `write_memory_file(path, content)`           | Create a new memory file or initialize `MEMORY.md`.     |
| `edit_memory_file(path, old_text, new_text)` | Update an existing memory or index pointer.             |
| `delete_memory_file(path)`                   | Remove an outdated memory file.                         |
| `search_memory_files(query)`                 | Search topic files when the loaded index is not enough. |

The save path mirrors Claude Code:

1. Check `MEMORY.md` and existing topic files first to avoid duplicates.
2. Write or update one topic file with frontmatter and a focused body.
3. Add or update one concise pointer in `MEMORY.md`.
4. Keep `MEMORY.md` short enough to load every session; move detail into topic files.

The recall path is:

1. Start from the loaded `MEMORY.md` index.
2. Read specific topic files when an index entry looks relevant.
3. Use `search_memory_files` for narrower lookup by names, descriptions, or body text.
4. Treat memory as context, not truth; verify current files/apps/resources before acting on drift-prone claims.

The sync path is cloud-mediated:

```
Mac local memory dirs
        ⇅ local sync CLI / daemon
Prototype Postgres virtual memory directory
        ⇅ memory-directory tools
Mobile managed agent
```

Local-to-cloud sync scans only Runner's production memory directory:

- `~/.runner/memory/`

Do not upload Codex memories, imported memory mirrors, Claude memory directories, or
`~/.runner-dev/memory/` in V0. Those are different products/environments and would
pollute the mobile agent's view of the user's Runner memory.

Cloud-to-local sync writes mobile-created memories back as real markdown files, preferably into a generated mirror first:

```
~/.codex/imported_memories/runner-mobile-cloud/
  MEMORY.md
  *.md
```

Internal install path:

```bash
RUNNER_MOBILE_ACCESS_TOKEN=... \
RUNNER_MOBILE_RUNNER_USER_ID=user@example.com \
RUNNER_MOBILE_WORKSPACE_ID=... \
pnpm memory:register --label "Alice's MacBook"

pnpm memory:sync
pnpm memory:daemon:install
```

`memory:register` stores the per-device sync token under `~/.runner-mobile-memory-sync/`.
`memory:sync` pushes local memory changes, pulls mobile-originated revisions, and updates
the local cursor. `memory:daemon:install` writes a macOS `launchd` job that runs sync every
five minutes. Users can manage it with `memory:daemon:start`, `memory:daemon:stop`,
`memory:daemon:status`, and `memory:daemon:uninstall`.

For the user-of-one prototype, keep conflict handling simple. Postgres is the canonical cloud replica, local files are synced views, and duplicate similar memories are acceptable. Use content hashes and timestamps to push/pull deltas. Deletes can be tombstones later; V0 can bias toward append/update over destructive removal.

Anthropic Managed Agents Memory Stores are a possible later optimization: mirror this Postgres-backed directory into a per-user Memory Store mounted at `/mnt/memory/personal`. That may improve file-tool ergonomics, but it should remain a cache/mirror unless we deliberately choose to make a beta provider feature canonical.

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

Tiny Postgres on Railway for V0 users and sessions:

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

The cloud memory replica adds prototype-owned memory tables later. Runner's existing backend remains unchanged.

---

## Tech stack

| Layer                                     | Choice                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Agent runtime                             | **Claude Managed Agents** (hosted harness, beta `managed-agents-2026-04-01`) |
| App infra (microsite, webhooks, cron, DB) | **Railway** (Postgres + Node services)                                       |
| iMessage / SMS                            | **Photon Spectrum** (`spectrum-ts`)                                          |
| Microsite                                 | Next.js or Vite + React (TBD, low-stakes)                                    |

---

## Feature list (final)

| Feature                                                   | Status                        |
| --------------------------------------------------------- | ----------------------------- |
| Magic Auth sign-in (email + 6-digit code)                 | ✅ V0                         |
| Microsite renders full integration catalog dynamically    | ✅ V0                         |
| In-microsite connect flow via `POST /api/v1/connect`      | ✅ V0                         |
| Existing users skip connection step                       | ✅ V0                         |
| iMessage thread per user (Spectrum); SMS fallback Android | ✅ V0                         |
| Persistent Managed Agents session per phone number        | ✅ V0                         |
| Agent inherits all Composio + MCP-OAuth integrations      | ✅ V0                         |
| Heartbeat cron 15-min, no cap, 9a–8p ET                   | ✅ V0                         |
| Minimum system prompt                                     | ✅ V0                         |
| Unipile integrations (LinkedIn, IG)                       | ❌ V0 — desktop-only          |
| Local macOS sources                                       | ❌ Mobile-impossible          |
| Shared session state with desktop                         | ❌ V0                         |
| Memory cloud-sync between desktop and mobile              | ❌ V0 — designed above for v1 |
| Double-heartbeat coordination                             | ❌ V0                         |
| Haiku ack pattern                                         | ❌ V0                         |
| Usage tracking on user's Runner quota                     | ❌ V0 (we eat inference cost) |
| Desktop-install nudge from mobile agent                   | ❌ V0                         |

## Net backend surgery: **zero**

Everything reuses existing endpoints (`/auth/magic-auth/*`, `/auth/refresh`, `/api/v1/workspaces`, `/api/v1/catalog`, `/api/v1/connect`, `/mcp/{workspaceId}/{slug}`).

---

## Open questions for v1+

- **Double heartbeat:** if user has both desktop and mobile, do they get heartbeats from both?
- **Memory sync:** implement the Postgres-backed virtual memory directory, local sync daemon, and mobile memory-directory tools described above.
- **Mobile-active proactivity gate:** turn off mobile heartbeat when desktop is on?
- **Inference billing:** route through `proxy.runner.now` so mobile usage counts against user's Runner quota?
- **Phone-as-identity:** add a `users.phone_number` column to runner backend, skip the email step entirely?
- **Unipile on mobile:** wrap Unipile as a backend MCP server so LinkedIn/IG work in mobile?
