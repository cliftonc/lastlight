import { useCallback, useEffect, useState } from "react";
import { api, isImageArtifact, isVideoArtifact } from "../api";
import { ArtifactEditor } from "./ArtifactEditor";
import { ArtifactImageViewer } from "./ArtifactImageViewer";
import { ArtifactVideoViewer } from "./ArtifactVideoViewer";
import {
  useUrlState,
  stringParser,
  stringSerializer,
} from "../hooks/useUrlState";

/**
 * Build-assets ("Artifacts") tab. Browses the server-mode handoff docs
 * (architect-plan.md, status.md, executor-summary.md, …) that live under
 * $STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/*.md and lets an operator
 * edit + save them via the shared {@link ArtifactEditor}.
 *
 * Deep-link params (set by server-mode PR links):
 *   ?tab=artifacts&repo=<owner>/<repo>&key=<issueKey>&doc=<file>
 * land directly on the selected doc.
 *
 * When no store is configured (repo mode) the list endpoints report empty and
 * the page degrades to a clear empty state rather than erroring.
 */
export function ArtifactsPage() {
  const [repo, setRepo] = useUrlState<string>("repo", "", stringParser, stringSerializer);
  const [key, setKey] = useUrlState<string>("key", "", stringParser, stringSerializer);
  const [doc, setDoc] = useUrlState<string>("doc", "", stringParser, stringSerializer);

  const [managedRepos, setManagedRepos] = useState<string[]>([]);
  const [repoInput, setRepoInput] = useState(repo);

  const [keys, setKeys] = useState<string[]>([]);
  const [files, setFiles] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [owner, name] = repo.includes("/") ? repo.split("/", 2) : ["", ""];

  // ── Populate the repo picker from the managed-repos config ───────────────
  useEffect(() => {
    let cancelled = false;
    api.config()
      .then((c) => {
        if (cancelled) return;
        const merged = c.merged as { managedRepos?: unknown };
        const repos = Array.isArray(merged.managedRepos)
          ? merged.managedRepos.filter((r): r is string => typeof r === "string")
          : [];
        setManagedRepos(repos);
      })
      .catch(() => { /* repo picker falls back to the text input */ });
    return () => { cancelled = true; };
  }, []);

  // ── Load keys whenever the repo changes ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!repo || !repo.includes("/")) {
      setKeys([]);
      return;
    }
    api.listArtifactKeys(repo)
      .then((res) => { if (!cancelled) setKeys(res.keys); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [repo]);

  // ── Load files whenever the key changes ──────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!repo || !repo.includes("/") || !key) {
      setFiles([]);
      return;
    }
    api.listArtifactFiles(owner, name, key)
      .then((res) => { if (!cancelled) setFiles(res.files); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [repo, key, owner, name]);

  const applyRepo = useCallback(() => {
    const next = repoInput.trim();
    setKey("");
    setDoc("");
    setRepo(next);
  }, [repoInput, setRepo, setKey, setDoc]);

  return (
    <div className="flex flex-1 overflow-hidden bg-base-100">
      {/* ── Left list pane ──────────────────────────────────────────────── */}
      <div className="w-72 shrink-0 border-r border-base-300 flex flex-col overflow-hidden">
        <div className="border-b border-base-300 px-3 py-3 space-y-2">
          <label className="text-xs font-semibold text-base-content/70">Repository</label>
          <div className="flex gap-1">
            <input
              type="text"
              value={repoInput}
              onChange={(e) => setRepoInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") applyRepo(); }}
              placeholder="owner/repo"
              list="artifact-managed-repos"
              className="flex-1 min-w-0 rounded border border-base-300 bg-base-200 px-2 py-1 text-xs"
            />
            <datalist id="artifact-managed-repos">
              {managedRepos.map((r) => <option key={r} value={r} />)}
            </datalist>
            <button
              onClick={applyRepo}
              className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-content hover:bg-primary/90"
            >
              Go
            </button>
          </div>
          {managedRepos.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {managedRepos.map((r) => (
                <button
                  key={r}
                  onClick={() => { setRepoInput(r); setKey(""); setDoc(""); setRepo(r); }}
                  className={`rounded px-1.5 py-0.5 text-[11px] ${
                    r === repo
                      ? "bg-primary/20 text-primary"
                      : "bg-base-200 text-base-content/70 hover:bg-base-300"
                  }`}
                >
                  {r}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-auto">
          {error && (
            <div className="m-2 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
              {error}
            </div>
          )}
          {repo && keys.length === 0 && !error ? (
            <div className="p-3 text-xs text-base-content/50">
              No build assets stored for this repo.
            </div>
          ) : (
            <ul className="py-1">
              {keys.map((k) => {
                const isOpen = k === key;
                return (
                  <li key={k}>
                    <button
                      onClick={() => { setDoc(""); setKey(isOpen ? "" : k); }}
                      className={`w-full text-left px-3 py-1.5 text-xs font-medium truncate ${
                        isOpen ? "bg-primary/10 text-primary" : "text-base-content/80 hover:bg-base-300/50"
                      }`}
                    >
                      {k}
                    </button>
                    {isOpen && (
                      <ul className="pb-1">
                        {files.length === 0 ? (
                          <li className="px-5 py-1 text-[11px] text-base-content/40">No docs</li>
                        ) : (
                          files.map((f) => (
                            <li key={f}>
                              <button
                                onClick={() => setDoc(f)}
                                className={`w-full text-left px-5 py-1 text-[11px] truncate ${
                                  f === doc
                                    ? "text-primary font-semibold"
                                    : "text-base-content/60 hover:text-base-content"
                                }`}
                              >
                                {f}
                              </button>
                            </li>
                          ))
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* ── Main pane — image/video viewer for evidence, else editor ───── */}
      {doc && isImageArtifact(doc) ? (
        <ArtifactImageViewer owner={owner} repo={name} docKey={key} doc={doc} />
      ) : doc && isVideoArtifact(doc) ? (
        <ArtifactVideoViewer owner={owner} repo={name} docKey={key} doc={doc} />
      ) : (
        <ArtifactEditor owner={owner} repo={name} docKey={key} doc={doc} />
      )}
    </div>
  );
}
