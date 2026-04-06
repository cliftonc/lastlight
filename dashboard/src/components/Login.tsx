import { useState } from "react";
import { api, auth } from "../api";

interface Props {
  onAuthed: () => void;
}

export function Login({ onAuthed }: Props) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  return (
    <div className="h-full flex items-center justify-center bg-base-100">
      <form
        onSubmit={submit}
        className="card bg-base-200 border border-base-300 w-80 shadow-sm"
      >
        <div className="card-body gap-4">
          <div>
            <div className="text-lg font-semibold tracking-tight">Last Light</div>
            <div className="text-xs text-base-content/50">Enter password to continue</div>
          </div>
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
        </div>
      </form>
    </div>
  );
}
