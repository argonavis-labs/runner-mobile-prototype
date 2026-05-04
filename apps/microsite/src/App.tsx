import { useEffect, useState } from "react";
import {
  magicAuthStart,
  magicAuthVerify,
  listWorkspaces,
  getMe,
  type MeResponse,
} from "./api.ts";
import { clearAuth, loadAuth, saveAuth, type AuthState } from "./state.ts";
import { TasksTab } from "./views/TasksTab.tsx";
import { ConnectionsTab } from "./views/ConnectionsTab.tsx";
import { AccountTab } from "./views/AccountTab.tsx";
import { PhoneLinkScreen } from "./views/PhoneLinkScreen.tsx";

type View =
  | { kind: "boot" }
  | { kind: "email" }
  | { kind: "code"; email: string }
  | { kind: "linking"; auth: AuthState; me: MeResponse | null }
  | { kind: "phone-link"; auth: AuthState; me: MeResponse }
  | { kind: "app"; auth: AuthState; me: MeResponse }
  | { kind: "error"; message: string };

type Tab = "tasks" | "connections" | "account";

export function App() {
  const [view, setView] = useState<View>({ kind: "boot" });
  const [tab, setTab] = useState<Tab>("tasks");

  useEffect(() => {
    const saved = loadAuth();
    if (!saved) {
      setView({ kind: "email" });
      return;
    }
    setView({ kind: "linking", auth: saved, me: null });
    void loadMe(saved, setView);
  }, []);

  switch (view.kind) {
    case "boot":
      return <Splash />;
    case "email":
      return (
        <EmailEntry
          onSent={(email) => setView({ kind: "code", email })}
          onError={(message) => setView({ kind: "error", message })}
        />
      );
    case "code":
      return (
        <CodeEntry
          email={view.email}
          onVerified={(auth) => {
            saveAuth(auth);
            setView({ kind: "linking", auth, me: null });
            void loadMe(auth, setView);
          }}
          onError={(message) => setView({ kind: "error", message })}
        />
      );
    case "linking":
      return <Splash message="Loading…" />;
    case "phone-link":
      return (
        <PhoneLinkScreen
          auth={view.auth}
          onLinked={(updated) => setView({ kind: "app", auth: view.auth, me: updated })}
          onSignOut={() => {
            clearAuth();
            setView({ kind: "email" });
          }}
        />
      );
    case "app":
      return (
        <AppShell tab={tab} setTab={setTab}>
          {tab === "tasks" && <TasksTab auth={view.auth} />}
          {tab === "connections" && <ConnectionsTab auth={view.auth} />}
          {tab === "account" && (
            <AccountTab
              auth={view.auth}
              me={view.me}
              onSignOut={() => {
                clearAuth();
                setView({ kind: "email" });
              }}
            />
          )}
        </AppShell>
      );
    case "error":
      return (
        <Mobile>
          <p className="eyebrow">Something's off</p>
          <h1 className="m-heading">Hmm.</h1>
          <p className="m-error">{view.message}</p>
          <div className="m-spacer" />
          <button
            className="m-btn m-btn-secondary"
            onClick={() => {
              clearAuth();
              setView({ kind: "email" });
            }}
          >
            Start over
          </button>
        </Mobile>
      );
  }
}

async function loadMe(auth: AuthState, setView: (v: View) => void) {
  try {
    const me = await getMe(auth);
    if (!me.phoneNumber) {
      setView({ kind: "phone-link", auth, me });
    } else {
      setView({ kind: "app", auth, me });
    }
  } catch (err) {
    setView({
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to load",
    });
  }
}

function Mobile({ children }: { children: React.ReactNode }) {
  return <div className="m-screen">{children}</div>;
}

function Splash({ message = "" }: { message?: string }) {
  return (
    <Mobile>
      <div className="m-splash">
        <div className="m-logo-mark">R</div>
        <p className="m-splash-text">{message}</p>
      </div>
    </Mobile>
  );
}

function EmailEntry({
  onSent,
  onError,
}: {
  onSent: (email: string) => void;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Mobile>
      <div className="m-hero">
        <div className="m-logo-mark">R</div>
        <h1 className="m-heading">Runner</h1>
        <p className="m-sub">Your agent in iMessage and on the web.</p>
      </div>
      <div className="m-form">
        <label className="m-label" htmlFor="email">
          Sign in with your Runner email
        </label>
        <input
          id="email"
          type="email"
          autoFocus
          autoComplete="email"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="you@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <button
          className="m-btn"
          disabled={!email || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await magicAuthStart(email.trim());
              onSent(email.trim());
            } catch (err) {
              onError(err instanceof Error ? err.message : "Failed to send code");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Send code"}
        </button>
      </div>
    </Mobile>
  );
}

function CodeEntry({
  email,
  onVerified,
  onError,
}: {
  email: string;
  onVerified: (auth: AuthState) => void;
  onError: (message: string) => void;
}) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Mobile>
      <div className="m-hero">
        <h1 className="m-heading">Check your email</h1>
        <p className="m-sub">
          Six-digit code sent to <strong>{email}</strong>
        </p>
      </div>
      <div className="m-form">
        <input
          type="text"
          inputMode="numeric"
          autoFocus
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="123456"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
        />
        <button
          className="m-btn"
          disabled={code.length !== 6 || busy}
          onClick={async () => {
            setBusy(true);
            try {
              const verify = await magicAuthVerify(email, code);
              let workspaceId = verify.default_workspace_id;
              if (!workspaceId) {
                const workspaces = await listWorkspaces(verify.access_token);
                const first = workspaces[0];
                if (!first) throw new Error("No workspaces found for this account");
                workspaceId = first.id;
              }
              const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
              onVerified({
                access_token: verify.access_token,
                refresh_token: verify.refresh_token,
                jwt_expires_at: expiresAt,
                runner_user_id: verify.email,
                workspace_id: workspaceId,
                email: verify.email,
              });
            } catch (err) {
              onError(err instanceof Error ? err.message : "Bad code");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Verifying…" : "Verify"}
        </button>
      </div>
    </Mobile>
  );
}

function AppShell({
  tab,
  setTab,
  children,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="m-app">
      <main className="m-app-main">{children}</main>
      <nav className="m-tabbar" role="tablist">
        <TabButton current={tab} value="tasks" label="Tasks" onSelect={setTab} icon="📋" />
        <TabButton current={tab} value="connections" label="Apps" onSelect={setTab} icon="🔌" />
        <TabButton current={tab} value="account" label="You" onSelect={setTab} icon="👤" />
      </nav>
    </div>
  );
}

function TabButton({
  current,
  value,
  label,
  onSelect,
  icon,
}: {
  current: Tab;
  value: Tab;
  label: string;
  onSelect: (t: Tab) => void;
  icon: string;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`m-tabbtn${active ? " m-tabbtn-active" : ""}`}
      onClick={() => onSelect(value)}
    >
      <span className="m-tabicon" aria-hidden="true">
        {icon}
      </span>
      <span className="m-tablabel">{label}</span>
    </button>
  );
}
