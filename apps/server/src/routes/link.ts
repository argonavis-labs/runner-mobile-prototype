import { Router } from "express";
import { z } from "zod";
import { db, users } from "@runner-mobile/db";
import { listWorkspaces } from "@runner-mobile/runner-api";
import { createSharedUser, redirectUrl } from "@runner-mobile/spectrum";

// E.164: '+' followed by 8-15 digits.
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/);

const linkInitSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  jwt_expires_at: z.string().datetime(),
  runner_user_id: z.string().min(1),
  workspace_id: z.string().min(1),
  phone_number: e164,
});

export const linkRouter: Router = Router();

linkRouter.post("/init", async (req, res) => {
  const parsed = linkInitSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    return;
  }
  const body = parsed.data;

  // Validate JWT against Runner backend by listing workspaces and confirming
  // the user actually owns workspace_id. Cheap, prevents random callers
  // registering arbitrary phone↔jwt pairs.
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

  // Create or upsert the Spectrum shared user, then persist locally.
  let sharedUser;
  try {
    sharedUser = await createSharedUser({ phoneNumber: body.phone_number });
  } catch (err) {
    console.error("Spectrum createSharedUser failed:", err);
    res.status(502).json({ error: "spectrum_failed" });
    return;
  }

  await db
    .insert(users)
    .values({
      phoneNumber: body.phone_number,
      runnerUserId: body.runner_user_id,
      workspaceId: body.workspace_id,
      jwt: body.access_token,
      refreshToken: body.refresh_token,
      jwtExpiresAt: new Date(body.jwt_expires_at),
      spectrumUserId: sharedUser.id,
      assignedPhoneNumber: sharedUser.assignedPhoneNumber,
    })
    .onConflictDoUpdate({
      target: users.phoneNumber,
      set: {
        runnerUserId: body.runner_user_id,
        workspaceId: body.workspace_id,
        jwt: body.access_token,
        refreshToken: body.refresh_token,
        jwtExpiresAt: new Date(body.jwt_expires_at),
        spectrumUserId: sharedUser.id,
        assignedPhoneNumber: sharedUser.assignedPhoneNumber,
      },
    });

  res.json({ redirectUrl: redirectUrl(sharedUser.id, "hi 👋") });
});
