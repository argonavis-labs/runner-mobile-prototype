/**
 * Claude Managed Agents wrapper.
 *
 * Per-user agent + session lifecycle for the iMessage companion. The agent
 * carries the user's MCP servers (one per connected Composio / first-party
 * MCP integration). The session persists across messages and holds memory
 * via the harness's persistent filesystem.
 *
 * The agent communicates with the user via the `send_imessage` custom tool;
 * the webhook/cron handler intercepts these tool calls and dispatches over
 * Spectrum.
 */

import Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { db, users, type User } from "@runner-mobile/db";
import { mcpUrl, type CatalogItem } from "@runner-mobile/runner-api";

const SYSTEM_PROMPT =
  "You're Runner, an assistant texting via iMessage. You have access to the apps the user has connected. Be helpful and natural. Replies short by default. Always send messages to the user via the send_imessage tool — never reply with plain text.";

const MODEL = "claude-opus-4-7";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({
    defaultHeaders: { "anthropic-beta": "managed-agents-2026-04-01" },
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
  // @ts-expect-error — beta surface, types may not include `environments` yet
  const env = await client().beta.environments.create({
    name: "runner-mobile",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  _environmentId = env.id;
  return _environmentId!;
}

function buildMcpServers(
  catalog: CatalogItem[],
  workspaceId: string,
  jwt: string,
): Array<{ type: "url"; url: string; name: string; authorization_token?: string }> {
  return catalog
    .filter((c) => c.status === "connected")
    .flatMap((c) =>
      c.connectedAccounts
        .filter((a) => a.state === "connected")
        .map((a) => ({
          type: "url" as const,
          name: a.accountIndex > 0 ? `${c.slug}-${a.accountIndex + 1}` : c.slug,
          url: mcpUrl(workspaceId, c.slug, a.accountIndex),
          authorization_token: jwt,
        })),
    );
}

const SEND_IMESSAGE_TOOL = {
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
} as const;

/**
 * Create or update the user's Managed Agent so its MCP servers reflect the
 * current catalog. Backend dedupes (no-op if unchanged).
 */
export async function ensureAgent(user: User, catalog: CatalogItem[]): Promise<string> {
  const mcpServers = buildMcpServers(catalog, user.workspaceId, user.jwt);
  const c = client();

  if (user.managedAgentId) {
    // @ts-expect-error — beta surface
    await c.beta.agents.update(user.managedAgentId, {
      system: SYSTEM_PROMPT,
      tools: [SEND_IMESSAGE_TOOL],
      mcp_servers: mcpServers,
    });
    return user.managedAgentId;
  }

  // @ts-expect-error — beta surface
  const agent = await c.beta.agents.create({
    name: `runner-mobile-${user.runnerUserId}`,
    model: MODEL,
    system: SYSTEM_PROMPT,
    tools: [SEND_IMESSAGE_TOOL],
    mcp_servers: mcpServers,
  });

  await db
    .update(users)
    .set({ managedAgentId: agent.id })
    .where(eq(users.phoneNumber, user.phoneNumber));

  return agent.id;
}

/**
 * Get the user's session, creating one if needed. Persists the new id back
 * to the users row.
 */
export async function ensureSession(user: User, agentId: string): Promise<string> {
  if (user.managedAgentsSessionId) return user.managedAgentsSessionId;

  const environmentId = await getEnvironmentId();
  // @ts-expect-error — beta surface
  const session = await client().beta.sessions.create({
    agent: agentId,
    environment_id: environmentId,
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
  // @ts-expect-error — beta surface
  const stream = await c.beta.sessions.events.stream(opts.sessionId);

  // @ts-expect-error — beta surface
  await c.beta.sessions.events.send(opts.sessionId, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: opts.userMessage }],
      },
    ],
  });

  const toolUseById = new Map<string, { name: string; input: Record<string, unknown> }>();
  let sentAnyImessage = false;

  for await (const event of stream as AsyncIterable<{
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    stop_reason?: { type: string; event_ids?: string[] };
  }>) {
    if (event.type === "agent.custom_tool_use" && event.id && event.name) {
      toolUseById.set(event.id, { name: event.name, input: event.input ?? {} });
      continue;
    }

    if (event.type === "session.status_idle") {
      const stopReason = event.stop_reason;
      if (stopReason?.type === "requires_action" && stopReason.event_ids) {
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

          // @ts-expect-error — beta surface
          await c.beta.sessions.events.send(opts.sessionId, {
            events: [
              {
                type: "user.custom_tool_result",
                custom_tool_use_id: eventId,
                content: [{ type: "text", text: resultText }],
              },
            ],
          });
        }
        // After resolving custom tool calls, the session goes back to running
        // and emits more events. Continue draining the stream.
        continue;
      }

      if (stopReason?.type === "end_turn" || stopReason?.type === "max_turns") {
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
 * Convenience: ensure agent + session exist for the user, then run one turn.
 * Pass the latest catalog so the agent's MCP servers reflect current state.
 */
export async function resumeOrSpawnAndRun(opts: {
  user: User;
  catalog: CatalogItem[];
  userMessage: string;
  onSendIMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const agentId = await ensureAgent(opts.user, opts.catalog);
  const sessionId = await ensureSession(opts.user, agentId);
  return runTurn({
    sessionId,
    userMessage: opts.userMessage,
    onSendIMessage: opts.onSendIMessage,
  });
}
