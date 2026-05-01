import { randomBytes } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { db, linkTokens } from "@runner-mobile/db";
import { listWorkspaces } from "@runner-mobile/runner-api";

const linkInitSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  jwt_expires_at: z.string().datetime(),
  runner_user_id: z.string().min(1),
  workspace_id: z.string().min(1),
});

export const linkRouter: Router = Router();

linkRouter.post("/init", async (req, res) => {
  const parsed = linkInitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;

  // Validate JWT against Runner backend by listing workspaces and checking
  // the user actually owns workspace_id.
  try {
    const workspaces = await listWorkspaces(body.access_token);
    const owns = workspaces.some((w) => w.id === body.workspace_id);
    if (!owns) {
      res.status(403).json({ error: "workspace_not_owned" });
      return;
    }
  } catch (err) {
    console.error("link/init JWT validation failed:", err);
    res.status(401).json({ error: "invalid_jwt" });
    return;
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 60_000); // 30 min

  await db.insert(linkTokens).values({
    token,
    runnerUserId: body.runner_user_id,
    workspaceId: body.workspace_id,
    jwt: body.access_token,
    refreshToken: body.refresh_token,
    jwtExpiresAt: new Date(body.jwt_expires_at),
    expiresAt,
  });

  res.json({ token });
});
