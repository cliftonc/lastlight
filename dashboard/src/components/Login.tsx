import { useState } from "react";
import { api, auth } from "../api";

interface Props {
  onAuthed: () => void;
  slackOAuth?: boolean;
}

export function Login({ onAuthed, slackOAuth }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [slackRedirecting, setSlackRedirecting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { token } = await api.login(password);
      auth.setToken(token);
      onAuthed();
    } catch (err) {
      setError((err as Error).message === "401 Unauthorized" ? "invalid password" : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleSlackLogin = () => {
    setSlackRedirecting(true);
    window.location.href = "/admin/api/oauth/slack/authorize";
  };

  return (
    <div className="h-full flex items-center justify-center bg-base-100">
      <div className="card bg-base-200 border border-base-300 w-80 shadow-sm">
        <div className="card-body gap-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">Last Light</div>
            <div className="text-xs text-base-content/50">Sign in to continue</div>
          </div>

          {slackOAuth && (
            <>
              <button
                type="button"
                className="btn btn-outline btn-sm w-full"
                onClick={handleSlackLogin}
                disabled={slackRedirecting}
              >
                {slackRedirecting ? "Redirecting..." : "Login with Slack"}
              </button>
              <div className="divider text-xs text-base-content/40 my-0">or</div>
            </>
          )}

          <form onSubmit={submit} className="flex flex-col gap-4">
            <input
              type="password"
              autoFocus
              className="input input-bordered input-sm w-full"
              placeholder="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <div className="text-xs text-error">{error}</div>}
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={busy || !password}
            >
              {busy ? "..." : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
