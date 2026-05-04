import { useEffect, useState } from "react";
import { connect, connectStatus, getCatalog, type CatalogItem } from "../api.ts";
import type { AuthState } from "../state.ts";

export function ConnectionsTab({ auth }: { auth: AuthState }) {
  const [items, setItems] = useState<CatalogItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setError(null);
    try {
      const cat = await getCatalog(auth.access_token, auth.workspace_id);
      setItems(cat);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    }
  }

  if (items === null) {
    return (
      <div className="m-tab">
        <header className="m-tasks-header">
          <div>
            <p className="eyebrow">Connections</p>
            <h1 className="m-tasks-heading">Your apps</h1>
          </div>
        </header>
        <p className="m-muted">{error ?? "Loading…"}</p>
      </div>
    );
  }

  const visible = items.filter((c) => c.backendType !== "local" && c.backendType !== "direct");
  const connected = visible.filter((c) => c.status === "connected");
  const available = visible.filter((c) => c.status !== "connected");

  return (
    <div className="m-tab">
      <header className="m-tasks-header">
        <div>
          <p className="eyebrow">Connections</p>
          <h1 className="m-tasks-heading">Your apps</h1>
        </div>
      </header>

      <p className="m-muted">
        Runner uses these to actually do things. The more you connect, the more it can handle.
      </p>

      {connected.length > 0 && (
        <section className="m-section">
          <header className="m-section-header">
            <h3 className="m-section-title">Connected</h3>
            <span className="m-section-count">{connected.length}</span>
          </header>
          <div className="m-conn-grid">
            {connected.map((c) => (
              <ConnRow key={c.slug} item={c} busy={busy === c.slug} onClick={() => {}} />
            ))}
          </div>
        </section>
      )}

      <section className="m-section">
        <header className="m-section-header">
          <h3 className="m-section-title">Available</h3>
          <span className="m-section-count">{available.length}</span>
        </header>
        <div className="m-conn-grid">
          {available.map((c) => (
            <ConnRow
              key={c.slug}
              item={c}
              busy={busy === c.slug}
              onClick={() => void handleConnect(c.slug)}
            />
          ))}
        </div>
      </section>

      {error && <p className="m-error">{error}</p>}
    </div>
  );

  async function handleConnect(slug: string) {
    setBusy(slug);
    try {
      const res = await connect(auth.access_token, auth.workspace_id, slug);
      if (res.status === "connected") {
        await load();
        return;
      }
      const popup = window.open(res.redirectUrl, "_blank");
      if (!popup) {
        window.location.href = res.redirectUrl;
        return;
      }
      const deadline = Date.now() + 5 * 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          const status = await connectStatus(auth.access_token, res.requestId);
          if (status.status === "connected") {
            await load();
            return;
          }
          if (status.status === "failed") return;
        } catch {
          // keep polling
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect");
    } finally {
      setBusy(null);
    }
  }
}

function ConnRow({
  item,
  busy,
  onClick,
}: {
  item: CatalogItem;
  busy: boolean;
  onClick: () => void;
}) {
  const connected = item.status === "connected";
  return (
    <button
      type="button"
      className={`m-conn-row${connected ? " m-conn-connected" : ""}`}
      disabled={connected || busy}
      onClick={onClick}
    >
      {item.icon ? (
        <img src={item.icon} alt="" className="m-conn-icon" />
      ) : (
        <div className="m-conn-icon m-conn-icon-blank" />
      )}
      <div className="m-conn-text">
        <div className="m-conn-name">{item.name}</div>
        <div className="m-conn-status">
          {connected ? "Connected" : busy ? "Authorizing…" : "Tap to connect"}
        </div>
      </div>
    </button>
  );
}
