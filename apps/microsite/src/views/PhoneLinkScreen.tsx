import { useEffect, useRef, useState } from "react";
import {
  checkPhoneLinkStatus,
  getMe,
  startPhoneLink,
  type MeResponse,
} from "../api.ts";
import type { AuthState } from "../state.ts";

type Step =
  | { kind: "loading" }
  | { kind: "code"; code: string; runnerPhoneNumber: string | null; expiresAt: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function PhoneLinkScreen({
  auth,
  onLinked,
  onSignOut,
}: {
  auth: AuthState;
  onLinked: (me: MeResponse) => void;
  onSignOut: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    void issue();
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function issue() {
    setStep({ kind: "loading" });
    try {
      const res = await startPhoneLink(auth);
      setStep({
        kind: "code",
        code: res.code,
        runnerPhoneNumber: res.runnerPhoneNumber,
        expiresAt: res.expiresAt,
      });
      startPolling(res.code);
    } catch (err) {
      setStep({ kind: "error", message: err instanceof Error ? err.message : "Failed" });
    }
  }

  function startPolling(code: string) {
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      try {
        const status = await checkPhoneLinkStatus(auth, code);
        if (status.linked) {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          const me = await getMe(auth);
          onLinked(me);
          return;
        }
        if (status.expired) {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          setStep({ kind: "expired" });
        }
      } catch {
        // transient — keep polling
      }
    }, 2500);
  }

  return (
    <div className="m-screen">
      <div className="m-hero">
        <h1 className="m-heading">One last step</h1>
        <p className="m-sub">Link your phone so Runner can text you.</p>
      </div>

      {step.kind === "loading" && <p className="m-muted">Setting up…</p>}

      {step.kind === "code" && (
        <>
          <div className="m-link-card">
            <div className="m-link-step">
              <span className="m-link-num">1</span>
              <div>
                <div className="m-link-label">Open Messages</div>
                <div className="m-link-value">
                  {step.runnerPhoneNumber ? (
                    <a className="m-link-tel" href={`sms:${step.runnerPhoneNumber}`}>
                      Text {formatPhone(step.runnerPhoneNumber)}
                    </a>
                  ) : (
                    "Text the Runner number"
                  )}
                </div>
              </div>
            </div>
            <div className="m-link-step">
              <span className="m-link-num">2</span>
              <div>
                <div className="m-link-label">Send this code</div>
                <div className="m-link-code">{step.code}</div>
              </div>
            </div>
            <p className="m-muted m-link-tip">
              We'll detect it automatically and bring you to your task list.
            </p>
          </div>
          <button
            type="button"
            className="m-btn m-btn-secondary"
            onClick={() => void issue()}
          >
            Get a new code
          </button>
        </>
      )}

      {step.kind === "expired" && (
        <>
          <p className="m-muted">That code expired. Get a fresh one.</p>
          <button type="button" className="m-btn" onClick={() => void issue()}>
            New code
          </button>
        </>
      )}

      {step.kind === "error" && (
        <>
          <p className="m-error">{step.message}</p>
          <button type="button" className="m-btn" onClick={() => void issue()}>
            Try again
          </button>
        </>
      )}

      <div className="m-spacer" />
      <button type="button" className="m-btn m-btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}

function formatPhone(e164: string): string {
  // +14155551234 → (415) 555-1234 for US numbers; pass others through.
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  if (m) return `(${m[1]}) ${m[2]}-${m[3]}`;
  return e164;
}
