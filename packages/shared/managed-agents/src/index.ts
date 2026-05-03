/**
 * Claude Managed Agents wrapper.
 *
 * Per-user lifecycle:
 *   - one Agent — carries MCP server URLs (Composio + first-party), system
 *     prompt, custom send_imessage_bubbles tool. Versioned; we update + bump.
 *   - one Vault — holds static-bearer Credentials (one per MCP server URL),
 *     each with the user's Runner JWT. Credentials are reconciled before
 *     every session turn so a JWT rotation re-syncs all of them.
 *   - one Session — references the agent + vault; resumes across messages
 *     so memory persists in the harness's filesystem.
 *
 * The agent communicates with the user via the `send_imessage_bubbles` custom tool;
 * the webhook/cron handler intercepts these calls and dispatches via Spectrum.
 *
 * All types come from the SDK (`@anthropic-ai/sdk` 0.92+). No type fabrication.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentCreateParams,
  AgentUpdateParams,
  BetaManagedAgentsAgentToolset20260401Params,
  BetaManagedAgentsCustomToolParams,
  BetaManagedAgentsMCPToolsetParams,
  BetaManagedAgentsURLMCPServerParams,
} from "@anthropic-ai/sdk/resources/beta/agents/agents";
import type {
  BetaManagedAgentsCredential,
  BetaManagedAgentsStaticBearerCreateParams,
  CredentialCreateParams,
} from "@anthropic-ai/sdk/resources/beta/vaults/credentials";
import type {
  BetaManagedAgentsAgentCustomToolUseEvent,
  BetaManagedAgentsImageBlock,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { eq } from "drizzle-orm";
import { db, users, type User } from "@runner-mobile/db";
import { mcpUrl, type CatalogItem } from "@runner-mobile/runner-api";

const SYSTEM_PROMPT = `You're Runner — your user's tool, not a chatbot. You reach them over iMessage and have full access to the apps they've connected (email, calendar, docs, tickets, CRMs, whatever's there), plus web search, fetch, and a persistent filesystem for memory.

Be aggressively helpful. A tool earns its keep by doing things, not by offering to.

Defaults:
- Action over discussion. If something can be done, do it. Investigate, set up, organize, file, summarize — then report what you did. Confirm after, not before, for anything reversible.
- One hard limit: don't contact other people. Anything that sends, replies, comments, posts, schedules with others, or otherwise lands in someone else's notifications needs explicit user approval. Draft it in full, show the user, wait for the go-ahead. The user is the only person you act for; everyone else gets a draft.
- Investigate before you answer. When the user mentions a person, project, or thread, look it up in their connected apps first. Bring receipts.
- Proactive on heartbeats. When you receive [heartbeat tick], mine the user's connected apps for things worth surfacing: unanswered important emails, calendar conflicts, PRs/tickets waiting on them, deadlines slipping, follow-ups they promised. If you find something useful, text. Stay silent only when there's genuinely nothing.
- Remember everything. Use the filesystem to persist user preferences, ongoing threads, names, projects, recurring tasks. Carry context across messages.

iMessage style:
- Short bubbles. Multiple short messages beat a wall of text. If an answer has more than one idea, send 2-4 bubbles.
- Plain text only. iMessage will not render Markdown reliably, so do not use Markdown headings, tables, code fences, blockquotes, or link formatting. Use simple punctuation and line breaks instead.
- Use send_imessage_bubbles with one self-contained bubble per idea. Each bubble should be short enough to read at a glance.
- Casual, direct, competent. No corporate hedging, no "I'd be happy to."
- Lead with the answer or the action. Skip preambles.

ALWAYS communicate via the send_imessage_bubbles tool — never reply with plain text. Tool calls are cheap; use them liberally before responding.`;

// Sonnet 4.6 — cost/speed step down from Opus 4.7. Managed Agents'
// model config only exposes `id` and `speed: standard|fast`; there is no
// thinking-budget parameter on the SDK surface (the harness emits
// `agent.thinking` events but doesn't let you control the budget).
const MODEL = "claude-sonnet-4-6";
const BETA_HEADER = "managed-agents-2026-04-01";
const OUTPUT_CONTRACT_VERSION = "imessage-bubbles-v1";
const MAX_BUBBLES_PER_TOOL_CALL = 6;
const MAX_IMESSAGE_BUBBLE_CHARS = 280;

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({
    defaultHeaders: { "anthropic-beta": BETA_HEADER },
  });
  return _client;
}

let _environmentId: string | null = process.env.MANAGED_AGENT_ENVIRONMENT_ID ?? null;

/**
 * Get or lazily create a shared Managed Agents environment.
 * Memoized in-process; recreated on cold start (cheap).
 */
export async function getEnvironmentId(): Promise<string> {
  if (_environmentId) return _environmentId;
  const env = await client().beta.environments.create({
    name: "runner-mobile",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  _environmentId = env.id;
  return _environmentId;
}

/**
 * Map the user's catalog into the shape the Managed Agents agent definition
 * expects: a list of URL-typed MCP servers. Auth is NOT inline — it's handled
 * by Vault credentials registered against each `mcp_server_url`.
 */
type McpServerEntry = {
  name: string;
  url: string;
};

function buildMcpServers(catalog: CatalogItem[], workspaceId: string): McpServerEntry[] {
  return catalog
    .filter((c) => c.status === "connected")
    .filter((c) => {
      // Exclude local (macOS — needs the user's Mac) and direct (Unipile —
      // currently client-side only, not exposed as backend MCP). Both would
      // be unreachable from the cloud container the agent runs in.
      const bt = c.backendType;
      return bt !== "local" && bt !== "direct";
    })
    .flatMap((c) =>
      c.connectedAccounts
        .filter((a) => a.state === "connected")
        .map<McpServerEntry>((a) => ({
          name: a.accountIndex > 0 ? `${c.slug}-${a.accountIndex + 1}` : c.slug,
          url: mcpUrl(workspaceId, c.slug, a.accountIndex),
        })),
    );
}

const SEND_IMESSAGE_BUBBLES_TOOL: BetaManagedAgentsCustomToolParams = {
  type: "custom",
  name: "send_imessage_bubbles",
  description:
    "Send one or more plain-text iMessage bubbles to the user. Each array item is delivered as a separate bubble. Use 2-4 bubbles for multi-idea answers. Do not use Markdown.",
  input_schema: {
    type: "object",
    properties: {
      bubbles: {
        type: "array",
        description:
          "Separate iMessage bubbles. Each bubble must be plain text, self-contained, and short.",
        minItems: 1,
        maxItems: MAX_BUBBLES_PER_TOOL_CALL,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: {
              type: "string",
              description: "Plain text for one iMessage bubble. No Markdown.",
              minLength: 1,
              maxLength: MAX_IMESSAGE_BUBBLE_CHARS,
            },
          },
          required: ["text"],
        },
      },
    },
    required: ["bubbles"],
  },
};

/**
 * Create or update the user's Managed Agent so its MCP servers reflect the
 * current catalog. Backend is no-op if nothing changed; we still bump the
 * stored version on a real change.
 *
 * Tool array (in order):
 *   1. send_imessage_bubbles — custom tool, the only way the agent talks to the user.
 *   2. agent_toolset_20260401 — built-in web search / fetch / bash / file ops.
 *      Always present so users with zero MCP connections still get something
 *      useful. always_allow so we never hit a confirmation gate.
 *   3. mcp_toolset(name=<server>) — one per connected MCP server. always_allow
 *      so MCP tool calls execute without going through tool-confirmation.
 *
 * Without explicit always_allow, MCP toolsets default to always_ask which
 * triggers `requires_action` events that aren't `user.custom_tool_result`-
 * shaped. Verified empirically: a Gmail call after the first text crashed
 * the turn loop with "tool_use_id ... does not match any custom_tool_use".
 */
const ALWAYS_ALLOW = { permission_policy: { type: "always_allow" } } as const;

const AGENT_TOOLSET: BetaManagedAgentsAgentToolset20260401Params = {
  type: "agent_toolset_20260401",
  default_config: ALWAYS_ALLOW,
};

type EnsuredAgent = {
  id: string;
  version: number;
};

export async function ensureAgent(user: User, catalog: CatalogItem[]): Promise<EnsuredAgent> {
  const c = client();
  const mcpServers: BetaManagedAgentsURLMCPServerParams[] = buildMcpServers(
    catalog,
    user.workspaceId,
  ).map((s) => ({ type: "url", name: s.name, url: s.url }));
  const mcpToolsets: BetaManagedAgentsMCPToolsetParams[] = mcpServers.map((s) => ({
    type: "mcp_toolset",
    mcp_server_name: s.name,
    default_config: ALWAYS_ALLOW,
  }));
  const tools = [SEND_IMESSAGE_BUBBLES_TOOL, AGENT_TOOLSET, ...mcpToolsets];

  if (user.managedAgentId && user.managedAgentVersion != null) {
    const params: AgentUpdateParams = {
      version: user.managedAgentVersion,
      // Pass model on update so existing agents pick up model changes
      // (otherwise update preserves whatever model was set at create time).
      model: MODEL,
      system: SYSTEM_PROMPT,
      tools,
      mcp_servers: mcpServers,
    };
    const updated = await c.beta.agents.update(user.managedAgentId, params);
    if (updated.version !== user.managedAgentVersion) {
      await db
        .update(users)
        .set({ managedAgentVersion: updated.version })
        .where(eq(users.phoneNumber, user.phoneNumber));
    }
    return { id: user.managedAgentId, version: updated.version };
  }

  const createParams: AgentCreateParams = {
    name: `runner-mobile-${user.runnerUserId}`,
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools,
    mcp_servers: mcpServers,
  };
  const agent = await c.beta.agents.create(createParams);

  await db
    .update(users)
    .set({ managedAgentId: agent.id, managedAgentVersion: agent.version })
    .where(eq(users.phoneNumber, user.phoneNumber));

  return { id: agent.id, version: agent.version };
}

/**
 * Ensure the user has a Vault and one static-bearer Credential per connected
 * MCP server URL holding the current Runner JWT. Reconciles on every call:
 * creates missing, updates token-mismatched, leaves orphans alone.
 */
export async function ensureVaultAndCredentials(
  user: User,
  catalog: CatalogItem[],
): Promise<string> {
  const c = client();

  let vaultId = user.managedAgentVaultId;
  if (!vaultId) {
    const vault = await c.beta.vaults.create({
      display_name: `runner-mobile-${user.runnerUserId}`,
    });
    vaultId = vault.id;
    await db
      .update(users)
      .set({ managedAgentVaultId: vaultId })
      .where(eq(users.phoneNumber, user.phoneNumber));
  }

  const desiredUrls = new Set(buildMcpServers(catalog, user.workspaceId).map((s) => s.url));
  if (desiredUrls.size === 0) return vaultId;

  // List existing credentials so we can reconcile by mcp_server_url.
  const existing: BetaManagedAgentsCredential[] = [];
  for await (const cred of c.beta.vaults.credentials.list(vaultId)) {
    existing.push(cred);
  }

  const byUrl = new Map<string, BetaManagedAgentsCredential>();
  for (const cred of existing) {
    const url = (cred.auth as { mcp_server_url?: string }).mcp_server_url;
    if (typeof url === "string") byUrl.set(url, cred);
  }

  for (const url of desiredUrls) {
    const found = byUrl.get(url);
    if (!found) {
      const auth: BetaManagedAgentsStaticBearerCreateParams = {
        type: "static_bearer",
        token: user.jwt,
        mcp_server_url: url,
      };
      const params: CredentialCreateParams = { auth };
      await c.beta.vaults.credentials.create(vaultId, params);
      continue;
    }
    // Always rotate the token — cheap, and ensures JWT-after-refresh propagates.
    await c.beta.vaults.credentials.update(found.id, {
      vault_id: vaultId,
      auth: { type: "static_bearer", token: user.jwt },
    });
  }

  return vaultId;
}

/**
 * Get the user's session, creating one if needed. Persists the new id back
 * to the users row.
 */
export async function ensureSession(
  user: User,
  agentId: string,
  agentVersion: number,
  vaultId: string,
): Promise<string> {
  const c = client();
  if (user.managedAgentsSessionId) {
    try {
      const existing = await c.beta.sessions.retrieve(user.managedAgentsSessionId);
      const currentContract =
        existing.agent.id === agentId &&
        existing.agent.version === agentVersion &&
        existing.metadata.output_contract_version === OUTPUT_CONTRACT_VERSION &&
        existing.archived_at === null &&
        existing.status !== "terminated";

      if (currentContract) return user.managedAgentsSessionId;

      await c.beta.sessions.archive(user.managedAgentsSessionId).catch((err) => {
        console.warn("failed to archive stale managed-agent session:", err);
      });
    } catch (err) {
      console.warn("failed to inspect managed-agent session; creating a fresh one:", err);
    }
  }

  const environmentId = await getEnvironmentId();
  const session = await c.beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
    metadata: { output_contract_version: OUTPUT_CONTRACT_VERSION },
    vault_ids: [vaultId],
  });

  await db
    .update(users)
    .set({ managedAgentsSessionId: session.id })
    .where(eq(users.phoneNumber, user.phoneNumber));

  return session.id;
}

/**
 * Run one turn: open stream, send user message, drain events, intercept
 * `send_imessage_bubbles` tool calls and dispatch via the provided callback.
 *
 * Returns true if the agent sent at least one iMessage during the turn.
 */
export async function runTurn(opts: {
  sessionId: string;
  userMessage: string;
  images?: ManagedAgentImage[];
  onSendIMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const c = client();
  const stream = await c.beta.sessions.events.stream(opts.sessionId);
  const userContent: Array<BetaManagedAgentsTextBlock | BetaManagedAgentsImageBlock> = [
    { type: "text", text: opts.userMessage },
    ...(opts.images ?? []).map((image) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        data: image.data,
        media_type: image.mimeType,
      },
    })),
  ];

  const userMessageEvents: EventSendParams = {
    events: [
      {
        type: "user.message",
        content: userContent,
      },
    ],
  };
  await c.beta.sessions.events.send(opts.sessionId, userMessageEvents);

  const toolUseById = new Map<string, BetaManagedAgentsAgentCustomToolUseEvent>();
  let sentAnyImessage = false;

  for await (const event of stream as AsyncIterable<BetaManagedAgentsStreamSessionEvents>) {
    if (event.type === "agent.custom_tool_use") {
      toolUseById.set(event.id, event);
      continue;
    }

    if (event.type === "session.status_idle") {
      const stopReason = (event as BetaManagedAgentsSessionStatusIdleEvent).stop_reason;
      if (stopReason.type === "requires_action") {
        // event_ids can include both `agent.custom_tool_use` (which we
        // respond to with `user.custom_tool_result`) AND other event types
        // like MCP/built-in tool uses awaiting confirmation (which need
        // `user.tool_confirmation`). We only handle the custom-tool case
        // here. With always_allow set on every toolset (see ensureAgent)
        // we shouldn't see confirmation requests in V0 — but if one does
        // arrive, skip it rather than crashing the turn.
        for (const eventId of stopReason.event_ids) {
          const tu = toolUseById.get(eventId);
          if (!tu) {
            console.warn(
              `requires_action event ${eventId} is not a custom_tool_use we tracked; skipping (likely tool_confirmation)`,
            );
            continue;
          }
          let resultText = "ok";
          if (tu.name === "send_imessage_bubbles") {
            const parsed = parseIMessageBubbles(tu.input);
            if (parsed.ok) {
              for (const bubble of parsed.bubbles) {
                try {
                  await opts.onSendIMessage(bubble);
                  sentAnyImessage = true;
                } catch (err) {
                  resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
                  break;
                }
              }
              if (resultText === "ok") resultText = `delivered ${parsed.bubbles.length} bubble(s)`;
            } else {
              resultText = `invalid iMessage payload: ${parsed.error} Retry by calling send_imessage_bubbles with short plain-text bubbles.`;
            }
          } else {
            resultText = `error: unknown tool ${tu.name}`;
          }

          const result: EventSendParams = {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: eventId,
                content: [{ type: "text", text: resultText }],
              },
            ],
          };
          await c.beta.sessions.events.send(opts.sessionId, result);
        }
        // After resolving custom tool calls, the session goes back to running
        // and emits more events. Continue draining the stream.
        continue;
      }

      if (stopReason.type === "end_turn" || stopReason.type === "retries_exhausted") {
        break;
      }
    }

    if (event.type === "session.status_terminated" || event.type === "session.error") {
      break;
    }
  }

  return sentAnyImessage;
}

type ParsedBubbles =
  | { ok: true; bubbles: string[] }
  | { ok: false; error: string };

export type ManagedAgentImage = {
  data: string;
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
};

function parseIMessageBubbles(input: unknown): ParsedBubbles {
  if (!isRecord(input)) return { ok: false, error: "tool input must be an object" };
  const bubblesInput = input.bubbles;
  if (!Array.isArray(bubblesInput)) {
    return { ok: false, error: "`bubbles` must be an array" };
  }
  if (bubblesInput.length === 0) {
    return { ok: false, error: "`bubbles` must include at least one bubble" };
  }
  if (bubblesInput.length > MAX_BUBBLES_PER_TOOL_CALL) {
    return {
      ok: false,
      error: `send at most ${MAX_BUBBLES_PER_TOOL_CALL} bubbles per tool call`,
    };
  }

  const bubbles: string[] = [];
  for (const [index, bubbleInput] of bubblesInput.entries()) {
    if (!isRecord(bubbleInput) || typeof bubbleInput.text !== "string") {
      return { ok: false, error: `bubble ${index + 1} must have a text string` };
    }

    const text = bubbleInput.text.trim();
    if (!text) return { ok: false, error: `bubble ${index + 1} is empty` };
    if (text.length > MAX_IMESSAGE_BUBBLE_CHARS) {
      return {
        ok: false,
        error: `bubble ${index + 1} is ${text.length} characters; max is ${MAX_IMESSAGE_BUBBLE_CHARS}`,
      };
    }
    if (containsMarkdown(text)) {
      return {
        ok: false,
        error: `bubble ${index + 1} contains Markdown; use plain iMessage text`,
      };
    }

    bubbles.push(text);
  }

  return { ok: true, bubbles };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsMarkdown(text: string): boolean {
  return [
    /```/,
    /`[^`\n]+`/,
    /^\s{0,3}#{1,6}\s+/m,
    /^\s{0,3}>\s+/m,
    /\[[^\]\n]+\]\([^)]+\)/,
    /(^|[^\w])(\*\*|__)[^*_]+(\*\*|__)(?!\w)/,
    /(^|[^\w])~~[^~]+~~(?!\w)/,
    /^\s*\|.*\|\s*$/m,
  ].some((pattern) => pattern.test(text));
}

/**
 * Convenience: ensure agent + vault + session exist for the user, then run
 * one turn. Pass the latest catalog so the agent's MCP servers and vault
 * credentials reflect current state.
 */
export async function resumeOrSpawnAndRun(opts: {
  user: User;
  catalog: CatalogItem[];
  userMessage: string;
  images?: ManagedAgentImage[];
  onSendIMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const agent = await ensureAgent(opts.user, opts.catalog);
  const vaultId = await ensureVaultAndCredentials(opts.user, opts.catalog);
  const sessionId = await ensureSession(opts.user, agent.id, agent.version, vaultId);
  return runTurn({
    sessionId,
    userMessage: opts.userMessage,
    images: opts.images,
    onSendIMessage: opts.onSendIMessage,
  });
}
