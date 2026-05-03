/**
 * Microsite-side API client. Talks directly to Runner backend for auth and
 * catalog operations, and to our own server for the iMessage handoff token.
 */

const RUNNER_BACKEND = import.meta.env.VITE_RUNNER_BACKEND ?? "https://api.runner.now";
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";

export type MagicAuthVerifyResponse = {
  access_token: string;
  refresh_token: string;
  email: string;
  name: string | null;
  is_new_user: boolean;
  default_workspace_id: string | null;
};

export type Workspace = { id: string; name: string };

export type ConnectedAccount = {
  id: string;
  accountIndex: number;
  state:
    | "connected"
    | "auth_required"
    | "permission_limited"
    | "degraded"
    | "provider_unavailable"
    | "setup_failed"
    | "pending";
  accountLabel: string | null;
};

export type CatalogItem = {
  slug: string;
  name: string;
  provider: string;
  icon?: string;
  category: string;
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

export type ConnectStatusResponse =
  | { status: "connected"; connectionId: string; accountIndex: number }
  | { status: "pending" | "failed" | "auth_required" | "permission_limited" | "degraded" | "provider_unavailable" | "setup_failed" };

async function runnerRequest<T>(
  method: "GET" | "POST",
  path: string,
  opts: { jwt?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(path, RUNNER_BACKEND);
  if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.jwt) headers.authorization = `Bearer ${opts.jwt}`;
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return parsed as T;
}

export async function magicAuthStart(email: string): Promise<void> {
  await runnerRequest("POST", "/auth/magic-auth/start", { body: { email } });
}

export async function magicAuthVerify(
  email: string,
  code: string,
): Promise<MagicAuthVerifyResponse> {
  return runnerRequest("POST", "/auth/magic-auth/verify", { body: { email, code } });
}

export async function listWorkspaces(jwt: string): Promise<Workspace[]> {
  return runnerRequest("GET", "/api/v1/workspaces", { jwt });
}

export async function getCatalog(jwt: string, workspaceId: string): Promise<CatalogItem[]> {
  return runnerRequest("GET", "/api/v1/catalog", { jwt, query: { workspaceId } });
}

export async function connect(
  jwt: string,
  workspaceId: string,
  slug: string,
): Promise<ConnectResponse> {
  return runnerRequest("POST", "/api/v1/connect", {
    jwt,
    body: { slug, workspaceId },
  });
}

export async function connectStatus(
  jwt: string,
  requestId: string,
): Promise<ConnectStatusResponse> {
  return runnerRequest("POST", "/api/v1/connect/status", {
    jwt,
    body: { requestId },
  });
}

export async function initImessageLink(args: {
  access_token: string;
  refresh_token: string;
  jwt_expires_at: string;
  runner_user_id: string;
  workspace_id: string;
  phone_number: string; // E.164
  time_zone?: string;
}): Promise<{ redirectUrl: string }> {
  const res = await fetch(`${SERVER_URL}/api/link/init`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`link/init failed: ${res.status} ${body}`);
  }
  return res.json();
}
