/**
 * Typed client for the Runner backend.
 *
 * Endpoints verified against /Users/yitongzhang/src/runner/services/backend/src/.
 * Backend uses `access_token` (not `jwt`) — we mirror that on the wire and store
 * it as `jwt` in our own DB.
 */

import { eq } from "drizzle-orm";
import { db, users, type User } from "@runner-mobile/db";

const RUNNER_BACKEND = process.env.RUNNER_BACKEND ?? "https://api.runner.now";

export type MagicAuthVerifyResponse = {
  access_token: string;
  refresh_token: string;
  email: string;
  name: string | null;
  is_new_user: boolean;
  default_workspace_id: string | null;
};

export type RefreshResponse = {
  access_token: string;
  refresh_token: string;
};

export type Workspace = {
  id: string;
  name: string;
  orgId: string | null;
};

export type ConnectedAccount = {
  id: string;
  accountIndex: number;
  label: string | null;
  accountLabel: string | null;
  state:
    | "connected"
    | "auth_required"
    | "permission_limited"
    | "degraded"
    | "provider_unavailable"
    | "setup_failed"
    | "pending";
};

export type CatalogItem = {
  slug: string;
  name: string;
  provider: string;
  icon?: string;
  category: string;
  tagline?: string;
  status:
    | "available"
    | "connected"
    | "auth_required"
    | "permission_limited"
    | "degraded"
    | "provider_unavailable"
    | "setup_failed"
    | "pending";
  connectedAccounts: ConnectedAccount[];
  backendType?: string;
  platform?: string;
};

export type ConnectResponse =
  | { status: "pending"; redirectUrl: string; requestId: string; sourceId: string }
  | { status: "connected"; redirectUrl: null; connectionId: string; sourceId: string };

class RunnerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    public readonly endpoint: string,
  ) {
    super(`Runner API ${endpoint} → ${status}: ${JSON.stringify(body)}`);
  }
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  opts: { jwt?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(path, RUNNER_BACKEND);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  const res = await fetch(url, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new RunnerApiError(res.status, parsed, `${method} ${path}`);
  return parsed as T;
}

export async function magicAuthStart(email: string): Promise<{ ok: true }> {
  return request("POST", "/auth/magic-auth/start", { body: { email } });
}

export async function magicAuthVerify(
  email: string,
  code: string,
): Promise<MagicAuthVerifyResponse> {
  return request("POST", "/auth/magic-auth/verify", { body: { email, code } });
}

export async function refreshAuth(refreshToken: string): Promise<RefreshResponse> {
  return request("POST", "/auth/refresh", { body: { refresh_token: refreshToken } });
}

export async function listWorkspaces(jwt: string): Promise<Workspace[]> {
  return request("GET", "/api/v1/workspaces", { jwt });
}

export async function getCatalog(jwt: string, workspaceId: string): Promise<CatalogItem[]> {
  return request("GET", "/api/v1/catalog", { jwt, query: { workspaceId } });
}

export async function connect(
  jwt: string,
  workspaceId: string,
  slug: string,
): Promise<ConnectResponse> {
  return request("POST", "/api/v1/connect", { jwt, body: { slug, workspaceId } });
}

/**
 * Build the per-connection MCP URL for the Managed Agents session.
 * Append `-N` to slug for accountIndex > 0 (e.g. `gmail-2`).
 */
export function mcpUrl(workspaceId: string, slug: string, accountIndex = 0): string {
  const finalSlug = accountIndex > 0 ? `${slug}-${accountIndex + 1}` : slug;
  return `${RUNNER_BACKEND}/mcp/${workspaceId}/${finalSlug}`;
}

/**
 * Refresh the user's JWT if it expires within the next 60s.
 * Persists rotated tokens back to the users row.
 */
export async function refreshIfExpired(user: User): Promise<User> {
  const oneMinFromNow = Date.now() + 60_000;
  if (user.jwtExpiresAt.getTime() > oneMinFromNow) return user;

  const refreshed = await refreshAuth(user.refreshToken);
  // Magic-auth returns access_token expiry inside the JWT; we don't decode here.
  // Treat refreshed tokens as fresh for ~24h to avoid a hot loop; backend will
  // 401 on expiry and the next call will re-refresh. (JWT is 30d so this is safe.)
  const newExpiresAt = new Date(Date.now() + 24 * 60 * 60_000);

  const [updated] = await db
    .update(users)
    .set({
      jwt: refreshed.access_token,
      refreshToken: refreshed.refresh_token,
      jwtExpiresAt: newExpiresAt,
    })
    .where(eq(users.phoneNumber, user.phoneNumber))
    .returning();

  if (!updated) throw new Error(`Failed to update user ${user.phoneNumber} after refresh`);
  return updated;
}

export { RunnerApiError };
