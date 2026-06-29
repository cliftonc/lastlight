import { useSyncExternalStore, useCallback } from "react";

/**
 * Dead-simple hash router: the URL is `#/<tierKey>/<runId>` (both optional).
 * No dependency, works under a plain static file server (no history rewrites).
 */
export interface Route {
  tierKey?: string;
  runId?: string;
}

function parse(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [tierKey, runId] = hash.split("/").map((s) => (s ? decodeURIComponent(s) : undefined));
  return { tierKey: tierKey || undefined, runId: runId || undefined };
}

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

let snapshot: Route = parse();
let snapshotHash = window.location.hash;
function getSnapshot(): Route {
  // useSyncExternalStore needs a stable reference between unchanged reads.
  if (window.location.hash !== snapshotHash) {
    snapshotHash = window.location.hash;
    snapshot = parse();
  }
  return snapshot;
}

export function navigate(tierKey?: string, runId?: string): void {
  const parts = [tierKey, runId].filter(Boolean).map((s) => encodeURIComponent(s as string));
  window.location.hash = parts.length ? `/${parts.join("/")}` : "/";
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useNavigate(): (tierKey?: string, runId?: string) => void {
  return useCallback(navigate, []);
}
