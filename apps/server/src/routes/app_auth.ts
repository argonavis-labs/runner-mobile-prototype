/**
 * Web-app session middleware. The mobile UI passes its magic-auth JWT and
 * workspace_id; we validate against the Runner backend (cheap: list
 * workspaces and confirm ownership) and resolve a memory replica.
 *
 * The JWT is verified live on each request rather than parsed locally — the
 * Runner backend is the source of truth for token validity and we can't fake
 * a workspaces-list response. Cached for the lifetime of one request.
 */

import type { NextFunction, Request, Response } from "express";
import { ensureMemoryReplica } from "@runner-mobile/db";
import { listWorkspaces } from "@runner-mobile/runner-api";

export type AppAuth = {
  jwt: string;
  workspaceId: string;
  runnerUserId: string;
  email: string;
  replicaId: number;
};

export type AppAuthRequest = Request & { appAuth?: AppAuth };

function bearer(req: Request): string | null {
  const header = req.header("authorization");
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

function workspaceFromHeader(req: Request): string | null {
  const direct = req.header("x-runner-workspace");
  if (direct && direct.trim()) return direct.trim();
  return null;
}

export async function requireAppAuth(
  req: AppAuthRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const jwt = bearer(req);
  if (!jwt) {
    res.status(401).json({ error: "missing_token" });
    return;
  }
  const workspaceId = workspaceFromHeader(req);
  if (!workspaceId) {
    res.status(400).json({ error: "missing_workspace" });
    return;
  }

  let workspaces;
  try {
    workspaces = await listWorkspaces(jwt);
  } catch (err) {
    res.status(401).json({ error: "invalid_token", detail: errMsg(err) });
    return;
  }
  const workspace = workspaces.find((w) => w.id === workspaceId);
  if (!workspace) {
    res.status(403).json({ error: "workspace_not_owned" });
    return;
  }

  // Backend doesn't return user_id directly in this flow; the microsite
  // already uses email as the runnerUserId handle (see App.tsx). Allow the
  // client to pass it explicitly via header to keep the middleware honest.
  const runnerUserId = req.header("x-runner-user-id")?.trim();
  const email = req.header("x-runner-email")?.trim();
  if (!runnerUserId || !email) {
    res.status(400).json({ error: "missing_identity_headers" });
    return;
  }

  const replicaId = await ensureMemoryReplica({ runnerUserId, workspaceId });
  req.appAuth = { jwt, workspaceId, runnerUserId, email, replicaId };
  next();
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
