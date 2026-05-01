import Anthropic from "@anthropic-ai/sdk";

async function main() {
  const c = new Anthropic({
    defaultHeaders: { "anthropic-beta": "managed-agents-2026-04-01" },
  });
  const env = await c.beta.environments.create({
    name: "runner-mobile-smoke",
    config: { type: "cloud", networking: { type: "unrestricted" } },
  });
  console.log("env:", env.id);

  const agent = await c.beta.agents.create({
    name: "smoke-test-agent",
    model: "claude-opus-4-7",
    system: "You are a test agent.",
    tools: [
      {
        type: "custom",
        name: "send_imessage",
        description: "send a text",
        input_schema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
    ],
    mcp_servers: [],
  });
  console.log("agent:", agent.id, "v" + agent.version);

  const vault = await c.beta.vaults.create({ display_name: "smoke-test-vault" });
  console.log("vault:", vault.id);

  // Cleanup
  await c.beta.agents.archive(agent.id);
  await c.beta.environments.delete(env.id);
  await c.beta.vaults.archive(vault.id);
  console.log("ok, cleaned up");
}

main().catch((err) => {
  console.error("smoke failed:", err);
  process.exit(1);
});
