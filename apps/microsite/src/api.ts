/**
 * Microsite-side API client. Talks directly to Runner backend for auth and
 * catalog operations, and to our own server for the iMessage handoff token,
 * phone link, and the tasks app surface.
 */

import type { AuthState } from "./state.ts";

const RUNNER_BACKEND = import.meta.env.VITE_RUNNER_BACKEND ?? "https://api.runner.now";
const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:4001";

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

// ---------- App API (our server) ----------

function appHeaders(auth: AuthState): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${auth.access_token}`,
    "x-runner-workspace": auth.workspace_id,
    "x-runner-user-id": auth.runner_user_id,
    "x-runner-email": auth.email,
  };
}

async function appRequest<T>(
  auth: AuthState,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: appHeaders(auth),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const detail = (parsed as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    const err = new Error(detail) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed as T;
}

export type MeResponse = {
  email: string;
  runnerUserId: string;
  workspaceId: string;
  phoneNumber: string | null;
  assignedPhoneNumber: string | null;
  timeZone: string | null;
};

export async function getMe(auth: AuthState): Promise<MeResponse> {
  return appRequest<MeResponse>(auth, "GET", "/api/app/me");
}

export type TaskStatus =
  | "triage"
  | "doing"
  | "waiting_user"
  | "waiting_external"
  | "done";

export type TaskMeta = {
  name: string | null;
  description: string | null;
  status: TaskStatus;
  nextStep: string | null;
  nextCheckIn: string | null;
  completedAt: string | null;
};

export type TaskSummary = {
  path: string;
  slug: string;
  revision: number;
  origin: string;
  updatedAt: string;
  meta: TaskMeta;
};

export type TaskFull = TaskSummary & { body: string; content: string };

export async function listTasks(auth: AuthState): Promise<{ tasks: TaskSummary[] }> {
  return appRequest(auth, "GET", "/api/app/tasks");
}

export async function getTask(auth: AuthState, slug: string): Promise<{ task: TaskFull }> {
  return appRequest(auth, "GET", `/api/app/tasks/${encodeURIComponent(slug)}`);
}

export async function patchTask(
  auth: AuthState,
  slug: string,
  patch: {
    revision: number;
    status?: TaskStatus;
    name?: string;
    description?: string;
    nextStep?: string;
    nextCheckIn?: string | null;
    body?: string;
  },
): Promise<{ task: TaskFull }> {
  return appRequest(auth, "PATCH", `/api/app/tasks/${encodeURIComponent(slug)}`, patch);
}

export async function deleteTask(auth: AuthState, slug: string): Promise<{ ok: true }> {
  return appRequest(auth, "DELETE", `/api/app/tasks/${encodeURIComponent(slug)}`);
}

export async function createTask(
  auth: AuthState,
  args: { title: string; body?: string },
): Promise<{ task: TaskFull }> {
  return appRequest(auth, "POST", "/api/app/tasks", args);
}

export async function nudgeTask(auth: AuthState, slug: string): Promise<{ ok: true }> {
  return appRequest(auth, "POST", `/api/app/tasks/${encodeURIComponent(slug)}/nudge`);
}

export async function startPhoneLink(
  auth: AuthState,
): Promise<{ code: string; expiresAt: string; runnerPhoneNumber: string | null }> {
  return appRequest(auth, "POST", "/api/app/phone/start", {
    refresh_token: auth.refresh_token,
    jwt_expires_at: auth.jwt_expires_at,
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

export async function checkPhoneLinkStatus(
  auth: AuthState,
  code: string,
): Promise<{ pending: boolean; expired: boolean; linked: boolean; phoneNumber: string | null }> {
  return appRequest(auth, "GET", `/api/app/phone/status?code=${encodeURIComponent(code)}`);
}
