import { useEffect, useState } from "react";
import {
  connect,
  connectStatus,
  getCatalog,
  initImessageLink,
  listWorkspaces,
  magicAuthStart,
  magicAuthVerify,
  type CatalogItem,
} from "./api.ts";
import { clearAuth, loadAuth, saveAuth, type AuthState } from "./state.ts";

type View =
  | { kind: "landing" }
  | { kind: "email" }
  | { kind: "code"; email: string }
  | { kind: "loading"; auth: AuthState; message: string }
  | { kind: "catalog"; auth: AuthState; catalog: CatalogItem[] }
  | { kind: "ready"; auth: AuthState; catalog: CatalogItem[] }
  | { kind: "phone"; auth: AuthState; catalog: CatalogItem[] }
  | { kind: "error"; message: string };

export function App() {
  const [view, setView] = useState<View>({ kind: "landing" });

  useEffect(() => {
    // Boot: if we have stored auth, jump straight to loading.
    const saved = loadAuth();
    if (saved) {
      setView({ kind: "loading", auth: saved, message: "Loading your apps…" });
      void hydrate(saved, setView);
    }
  }, []);

  switch (view.kind) {
    case "landing":
      return <Landing onStart={() => setView({ kind: "email" })} />;
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
            setView({ kind: "loading", auth, message: "Loading your apps…" });
            void hydrate(auth, setView);
          }}
          onError={(message) => setView({ kind: "error", message })}
        />
      );
    case "loading":
      return <Loading message={view.message} />;
    case "catalog":
      return (
        <Catalog
          auth={view.auth}
          items={view.catalog}
          onUpdate={() => {
            setView({ kind: "loading", auth: view.auth, message: "Refreshing…" });
            void hydrate(view.auth, setView);
          }}
        />
      );
    case "ready":
      return (
        <Ready
          auth={view.auth}
          catalog={view.catalog}
          onContinue={() => setView({ kind: "phone", auth: view.auth, catalog: view.catalog })}
        />
      );
    case "phone":
      return (
        <PhoneEntry
          auth={view.auth}
          onError={(message) => setView({ kind: "error", message })}
        />
      );
    case "error":
      return (
        <Shell>
          <p className="eyebrow">Something's off</p>
          <h1 className="type-heading-1">Hmm.</h1>
          <p className="error-text">{view.message}</p>
          <div className="spacer" />
          <button
            className="secondary"
            onClick={() => {
              clearAuth();
              setView({ kind: "landing" });
            }}
          >
            Start over
          </button>
        </Shell>
      );
  }
}

async function hydrate(auth: AuthState, setView: (v: View) => void) {
  try {
    const catalog = await getCatalog(auth.access_token, auth.workspace_id);
    const hasConnected = catalog.some((c) => c.status === "connected");
    if (hasConnected) {
      setView({ kind: "ready", auth, catalog });
    } else {
      setView({ kind: "catalog", auth, catalog });
    }
  } catch (err) {
    setView({
      kind: "error",
      message: err instanceof Error ? err.message : "Failed to load",
    });
  }
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="shell">{children}</div>;
}

function Landing({ onStart }: { onStart: () => void }) {
  return (
    <Shell>
      <p className="eyebrow reveal">Runner mobile</p>
      <h1 className="type-display reveal">Your agent in iMessage.</h1>
      <p className="type-body reveal" style={{ animationDelay: "60ms" }}>
        Text Runner. It uses the apps you already connected on desktop — and gets work done while
        you're not at your laptop.
      </p>
      <div className="spacer" />
      <button onClick={onStart} className="reveal" style={{ animationDelay: "120ms" }}>
        Get started
      </button>
    </Shell>
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
    <Shell>
      <p className="eyebrow">Step 1 of 3</p>
      <h1 className="type-heading-1">What's your email?</h1>
      <p className="type-body">We'll send you a 6-digit code.</p>
      <input
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
    </Shell>
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
    <Shell>
      <p className="eyebrow">Step 1 of 3 · Verify</p>
      <h1 className="type-heading-1">Check your email.</h1>
      <p className="type-body">
        Six-digit code sent to <strong style={{ color: "var(--marketing-heading)" }}>{email}</strong>.
      </p>
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
            // JWT expiry isn't returned directly; assume 30d (matches Runner backend
            // — the refresh helper handles re-rotation).
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60_000).toISOString();
            onVerified({
              access_token: verify.access_token,
              refresh_token: verify.refresh_token,
              jwt_expires_at: expiresAt,
              runner_user_id: verify.email, // backend doesn't expose user_id; use email as stable handle
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
    </Shell>
  );
}

function Loading({ message }: { message: string }) {
  return (
    <Shell>
      <p className="eyebrow">One sec</p>
      <h1 className="type-heading-1">{message}</h1>
    </Shell>
  );
}

function Catalog({
  auth,
  items,
  onUpdate,
}: {
  auth: AuthState;
  items: CatalogItem[];
  onUpdate: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  // Hide local-only integrations and Unipile-direct (per V0 plan).
  const visible = items.filter(
    (c) => c.backendType !== "local" && c.backendType !== "direct",
  );

  const handleConnect = async (slug: string) => {
    setBusy(slug);
    try {
      const res = await connect(auth.access_token, auth.workspace_id, slug);
      if (res.status === "connected") {
        onUpdate();
        return;
      }
      // Open Composio's hosted OAuth page in a new tab so the microsite
      // stays on screen and we can poll for completion.
      //
      // NOTE: do NOT pass `noopener,noreferrer` — Safari (and some other
      // browsers) return `null` from window.open when those flags are set,
      // even when the tab actually opens. That triggered our popup-blocked
      // fallback and navigated the current tab too, leaving the user stuck.
      const popup = window.open(res.redirectUrl, "_blank");
      if (!popup) {
        // True popup-block (rare on mobile from a click handler). Fall back
        // to navigating the current tab — user comes back manually.
        window.location.href = res.redirectUrl;
        return;
      }

      // Poll /api/v1/connect/status until we see `connected`, the user
      // gives up, or 5 minutes elapses.
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const status = await connectStatus(auth.access_token, res.requestId);
          if (status.status === "connected") {
            onUpdate();
            return;
          }
          if (status.status === "failed") {
            setBusy(null);
            return;
          }
        } catch {
          // transient; keep polling
        }
      }
      // Timeout — reset so user can retry.
      setBusy(null);
    } catch (err) {
      console.error(err);
      setBusy(null);
    }
  };

  const hasConnected = items.some((c) => c.status === "connected");

  return (
    <Shell>
      <p className="eyebrow">Step 2 of 3</p>
      <h1 className="type-heading-1">Connect your apps.</h1>
      <p className="type-body">Pick at least one. The agent uses these to actually do things.</p>
      {busy && (
        <div className="banner">
          <p>
            We opened {visible.find((c) => c.slug === busy)?.name ?? busy} in a new tab. Authorize
            there, then come back here — we'll detect it automatically.
          </p>
        </div>
      )}
      <div className="catalog">
        {visible.map((c) => {
          const connected = c.status === "connected";
          return (
            <div
              key={c.slug}
              className={`catalog-item${connected ? " connected" : ""}`}
              onClick={() => !busy && !connected && handleConnect(c.slug)}
            >
              {c.icon ? <img src={c.icon} alt="" /> : <div style={{ width: 32, height: 32 }} />}
              <div className="name">{c.name}</div>
              <div className="status">
                {connected
                  ? "Connected"
                  : busy === c.slug
                    ? "Authorizing…"
                    : "Connect"}
              </div>
            </div>
          );
        })}
      </div>
      <button onClick={() => onUpdate()} style={{ marginTop: 8 }}>
        {hasConnected ? "Continue" : "Skip for now"}
      </button>
    </Shell>
  );
}

function Ready({
  auth: _auth,
  catalog,
  onContinue,
}: {
  auth: AuthState;
  catalog: CatalogItem[];
  onContinue: () => void;
}) {
  const connected = catalog.filter((c) => c.status === "connected");
  const names = connected
    .slice(0, 4)
    .map((c) => c.name)
    .join(", ");
  const more = connected.length > 4 ? `, and ${connected.length - 4} more` : "";

  return (
    <Shell>
      <p className="eyebrow">Welcome back</p>
      <h1 className="type-heading-1">You're set.</h1>
      <p className="type-body">
        We see {names}
        {more} connected. The agent has them ready to use.
      </p>
      <div className="banner">
        <p>One more step — your phone number so we can route iMessages to your agent.</p>
      </div>
      <div className="spacer" />
      <button onClick={onContinue}>Continue</button>
    </Shell>
  );
}

/**
 * Normalize whatever the user typed into a strict E.164 (`+<digits>`) form.
 * - "+14155551234" → "+14155551234"
 * - "14155551234"  → "+14155551234"
 * - "4155551234"   → "+14155551234"   (assume US/Canada when 10 digits)
 * - "(415) 555-1234" → "+14155551234"
 * Returns null if the input doesn't normalize to a valid 11-15 digit number
 * starting with a country code we recognize (any non-zero leading digit).
 */
function normalizeToE164(input: string): string | null {
  const digits = input.replace(/\D/g, "");
  if (digits.length === 10) {
    // Bare 10-digit US/Canada — prepend +1.
    return `+1${digits}`;
  }
  if (digits.length >= 11 && digits.length <= 15 && digits[0] !== "0") {
    return `+${digits}`;
  }
  return null;
}

function PhoneEntry({
  auth,
  onError,
}: {
  auth: AuthState;
  onError: (message: string) => void;
}) {
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    const normalized = normalizeToE164(phone);
    if (!normalized) {
      onError("That doesn't look like a phone number. Try the format your iMessage uses.");
      return;
    }
    setBusy(true);
    try {
      const { redirectUrl } = await initImessageLink({
        access_token: auth.access_token,
        refresh_token: auth.refresh_token,
        jwt_expires_at: auth.jwt_expires_at,
        runner_user_id: auth.runner_user_id,
        workspace_id: auth.workspace_id,
        phone_number: normalized,
      });
      window.location.href = redirectUrl;
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to start iMessage");
      setBusy(false);
    }
  };

  return (
    <Shell>
      <p className="eyebrow">Step 3 of 3</p>
      <h1 className="type-heading-1">Your phone number?</h1>
      <p className="type-body">The one your iMessage uses.</p>
      <input
        type="tel"
        autoFocus
        autoComplete="tel"
        placeholder="(415) 555-1234"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
      />
      <div className="spacer" />
      <button disabled={busy} onClick={handleSubmit}>
        {busy ? "Opening Messages…" : "Tap to text Runner"}
      </button>
    </Shell>
  );
}
