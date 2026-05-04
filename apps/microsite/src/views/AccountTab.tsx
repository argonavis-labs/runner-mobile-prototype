import type { MeResponse } from "../api.ts";
import type { AuthState } from "../state.ts";

export function AccountTab({
  auth,
  me,
  onSignOut,
}: {
  auth: AuthState;
  me: MeResponse;
  onSignOut: () => void;
}) {
  return (
    <div className="m-tab">
      <header className="m-tasks-header">
        <div>
          <p className="eyebrow">You</p>
          <h1 className="m-tasks-heading">Account</h1>
        </div>
      </header>

      <dl className="m-account">
        <div className="m-account-row">
          <dt className="m-label">Email</dt>
          <dd>{auth.email}</dd>
        </div>
        <div className="m-account-row">
          <dt className="m-label">Phone</dt>
          <dd>{me.phoneNumber ?? "Not linked"}</dd>
        </div>
        {me.assignedPhoneNumber && (
          <div className="m-account-row">
            <dt className="m-label">Runner number</dt>
            <dd>
              <a className="m-link-tel" href={`sms:${me.assignedPhoneNumber}`}>
                {me.assignedPhoneNumber}
              </a>
            </dd>
          </div>
        )}
        {me.timeZone && (
          <div className="m-account-row">
            <dt className="m-label">Timezone</dt>
            <dd>{me.timeZone}</dd>
          </div>
        )}
        <div className="m-account-row">
          <dt className="m-label">Workspace</dt>
          <dd>{me.workspaceId}</dd>
        </div>
      </dl>

      <div className="m-spacer" />
      <button type="button" className="m-btn m-btn-secondary" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  );
}
