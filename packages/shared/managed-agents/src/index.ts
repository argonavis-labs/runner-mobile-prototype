/**
 * Claude Managed Agents wrapper.
 *
 * Per-user lifecycle:
 *   - one Agent — carries MCP server URLs (Composio + first-party), system
 *     prompt, custom send_imessage tool. Versioned; we update + bump.
 *   - one Vault — holds static-bearer Credentials (one per MCP server URL),
 *     each with the user's Runner JWT. Credentials are reconciled before
 *     every session turn so a JWT rotation re-syncs all of them.
 *   - one Session — references the agent + vault; resumes across messages
 *     so memory persists in the harness's filesystem.
 *
 * The agent communicates with the user via the `send_imessage` custom tool;
 * the webhook/cron handler intercepts these calls and dispatches via Spectrum.
 *
 * All types come from the SDK (`@anthropic-ai/sdk` 0.92+). No type fabrication.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  AgentCreateParams,
  AgentUpdateParams,
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
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsStreamSessionEvents,
  EventSendParams,
} from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { eq } from "drizzle-orm";
import { db, users, type User } from "@runner-mobile/db";
import { mcpUrl, type CatalogItem } from "@runner-mobile/runner-api";

const SYSTEM_PROMPT =
  "You're Runner, an assistant texting via iMessage. You have access to the apps the user has connected. Be helpful and natural. Replies short by default. Always send messages to the user via the send_imessage tool — never reply with plain text.";

// Sonnet 4.6 — cost/speed step down from Opus 4.7. Managed Agents'
// model config only exposes `id` and `speed: standard|fast`; there is no
// thinking-budget parameter on the SDK surface (the harness emits
// `agent.thinking` events but doesn't let you control the budget).
const MODEL = "claude-sonnet-4-6";
const BETA_HEADER = "managed-agents-2026-04-01";

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

const SEND_IMESSAGE_TOOL: BetaManagedAgentsCustomToolParams = {
  type: "custom",
  name: "send_imessage",
  description:
    "Send a message to the user via iMessage. This is the only way to communicate with the user. Call once per outgoing message.",
  input_schema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The text to send to the user" },
    },
    required: ["message"],
  },
};

/**
 * Create or update the user's Managed Agent so its MCP servers reflect the
 * current catalog. Backend is no-op if nothing changed; we still bump the
 * stored version on a real change.
 *
 * For every MCP server declared, a matching `mcp_toolset` tool entry is
 * required — the agent will reject the config otherwise (verified empirically:
 * "mcp_servers [...] declared but no mcp_toolset in tools references them").
 */
export async function ensureAgent(user: User, catalog: CatalogItem[]): Promise<string> {
  const c = client();
  const mcpServers: BetaManagedAgentsURLMCPServerParams[] = buildMcpServers(
    catalog,
    user.workspaceId,
  ).map((s) => ({ type: "url", name: s.name, url: s.url }));
  const mcpToolsets: BetaManagedAgentsMCPToolsetParams[] = mcpServers.map((s) => ({
    type: "mcp_toolset",
    mcp_server_name: s.name,
  }));
  const tools = [SEND_IMESSAGE_TOOL, ...mcpToolsets];

  if (user.managedAgentId && user.managedAgentVersion != null) {
    const params: AgentUpdateParams = {
      version: user.managedAgentVersion,
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
    return user.managedAgentId;
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

  return agent.id;
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
  vaultId: string,
): Promise<string> {
  if (user.managedAgentsSessionId) return user.managedAgentsSessionId;

  const environmentId = await getEnvironmentId();
  const session = await client().beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
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
 * `send_imessage` tool calls and dispatch via the provided callback.
 *
 * Returns true if the agent sent at least one iMessage during the turn.
 */
export async function runTurn(opts: {
  sessionId: string;
  userMessage: string;
  onSendIMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const c = client();
  const stream = await c.beta.sessions.events.stream(opts.sessionId);

  const userMessageEvents: EventSendParams = {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: opts.userMessage }],
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
        for (const eventId of stopReason.event_ids) {
          const tu = toolUseById.get(eventId);
          let resultText = "ok";
          if (tu?.name === "send_imessage") {
            const message = (tu.input as { message?: unknown }).message;
            if (typeof message === "string" && message.trim().length > 0) {
              try {
                await opts.onSendIMessage(message);
                sentAnyImessage = true;
                resultText = "delivered";
              } catch (err) {
                resultText = `error: ${err instanceof Error ? err.message : String(err)}`;
              }
            } else {
              resultText = "error: missing or empty message";
            }
          } else {
            resultText = `error: unknown tool ${tu?.name ?? "<unknown>"}`;
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

/**
 * Convenience: ensure agent + vault + session exist for the user, then run
 * one turn. Pass the latest catalog so the agent's MCP servers and vault
 * credentials reflect current state.
 */
export async function resumeOrSpawnAndRun(opts: {
  user: User;
  catalog: CatalogItem[];
  userMessage: string;
  onSendIMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const agentId = await ensureAgent(opts.user, opts.catalog);
  const vaultId = await ensureVaultAndCredentials(opts.user, opts.catalog);
  const sessionId = await ensureSession(opts.user, agentId, vaultId);
  return runTurn({
    sessionId,
    userMessage: opts.userMessage,
    onSendIMessage: opts.onSendIMessage,
  });
}
