import { useState } from "react";
import { auth } from "../api";

/**
 * Shown after the user is authenticated when the dashboard was opened by
 * `lastlight login` (a loopback `cli_callback` was present in the URL). It
 * hands the session token back to the local CLI by redirecting the browser to
 * the loopback callback with `?token=&state=`.
 *
 * The callback host is validated as loopback by App.tsx before we ever get
 * here, so we only redirect to 127.0.0.1 / localhost. We still require explicit
 * user consent (Authorize) so a logged-in session can't be silently siphoned.
 */
export function CliAuthorize({
  callback,
  state,
  onCancel,
}: {
  callback: string;
  state: string;
  onCancel: () => void;
}) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let host = callback;
  try {
    host = new URL(callback).host;
  } catch {
    /* shown as-is */
  }

  const authorize = async () => {
    setWorking(true);
    setError(null);
    try {
      // Normally the token is already in localStorage. If auth is disabled the
      // dashboard renders without one — mint a throwaway token so the CLI still
      // receives something to send (the instance accepts an empty body then).
      let token = auth.getToken();
      if (!token) {
        const res = await fetch("/admin/api/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        });
        if (res.ok) token = ((await res.json()) as { token?: string }).token ?? null;
      }
      if (!token) {
        setError("No token available to hand to the CLI.");
        setWorking(false);
        return;
      }
      const url = `${callback}?token=${encodeURIComponent(token)}&state=${encodeURIComponent(state)}`;
      window.location.href = url;
    } catch (e) {
      setError((e as Error).message);
      setWorking(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="card bg-base-200 shadow-xl w-full max-w-md">
        <div className="card-body">
          <h2 className="card-title">Authorize CLI login</h2>
          <p className="text-sm text-base-content/70">
            A command-line tool on this machine (<code className="text-xs">{host}</code>) is
            requesting access to this Last Light instance. Authorizing sends it a session token
            valid for ~7 days.
          </p>
          {error && <div className="alert alert-error text-sm">{error}</div>}
          <div className="card-actions justify-end mt-2">
            <button className="btn btn-ghost" onClick={onCancel} disabled={working}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={authorize} disabled={working}>
              {working ? "Authorizing…" : "Authorize"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
