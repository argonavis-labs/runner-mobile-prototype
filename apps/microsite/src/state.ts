/**
 * Persisted auth state. Survives the OAuth round-trip (microsite → Composio →
 * microsite) via localStorage.
 */

const KEY = "runner-mobile-auth";

export type AuthState = {
  access_token: string;
  refresh_token: string;
  jwt_expires_at: string; // ISO
  runner_user_id: string;
  workspace_id: string;
  email: string;
};

export function loadAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AuthState;
  } catch {
    return null;
  }
}

export function saveAuth(state: AuthState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function clearAuth(): void {
  localStorage.removeItem(KEY);
}
