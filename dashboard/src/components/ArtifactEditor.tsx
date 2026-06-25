import { useCallback, useEffect, useRef, useState } from "react";
import {
  MDXEditor,
  type MDXEditorMethods,
  headingsPlugin,
  listsPlugin,
  quotePlugin,
  thematicBreakPlugin,
  markdownShortcutPlugin,
  linkPlugin,
  toolbarPlugin,
  UndoRedo,
  BoldItalicUnderlineToggles,
  BlockTypeSelect,
  ListsToggle,
  CreateLink,
} from "@mdxeditor/editor";
import "@mdxeditor/editor/style.css";
import { api } from "../api";

interface ArtifactEditorProps {
  /** GitHub owner. */
  owner: string;
  /** Bare repository name. */
  repo: string;
  /** issueKey (build-asset run key). */
  docKey: string;
  /** Doc filename, e.g. architect-plan.md. Empty → placeholder. */
  doc: string;
}

/**
 * The build-asset markdown editor — load / edit / revert / save for one
 * server-mode handoff doc, with an MDXEditor and a header toolbar. Extracted
 * from ArtifactsPage so the focused approval view can reuse the exact same
 * editing surface. Renders the right-hand "editor pane" (header + body);
 * callers supply whatever surrounds it (a list pane, an approval footer, …).
 */
export function ArtifactEditor({ owner, repo, docKey, doc }: ArtifactEditorProps) {
  const [content, setContent] = useState<string>("");
  const [savedContent, setSavedContent] = useState<string>("");
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const editorRef = useRef<MDXEditorMethods>(null);
  const dirty = content !== savedContent;
  const ready = !!owner && !!repo && !!docKey && !!doc;
  const repoFull = owner && repo ? `${owner}/${repo}` : "";

  // ── Dark-theme the portaled toolbar popups ───────────────────────────────
  // MDXEditor's BlockTypeSelect (and other Radix selects) render their dropdown
  // into a portal on document.body — outside the editor's own `dark-theme`
  // root. The `.dark-theme` class defines only CSS variables consumed by
  // MDXEditor, so scoping it to <body> while an editor is mounted recolors the
  // portaled popups without affecting the rest of the app.
  useEffect(() => {
    document.body.classList.add("dark-theme");
    return () => { document.body.classList.remove("dark-theme"); };
  }, []);

  // ── Load the selected doc into the editor ────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!ready) {
      setContent("");
      setSavedContent("");
      return;
    }
    setLoadingDoc(true);
    setError(null);
    setSaveError(null);
    setSavedAt(null);
    api.getArtifact(owner, repo, docKey, doc)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
        editorRef.current?.setMarkdown(text);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => { if (!cancelled) setLoadingDoc(false); });
    return () => { cancelled = true; };
  }, [owner, repo, docKey, doc, ready]);

  const handleRevert = useCallback(() => {
    setContent(savedContent);
    editorRef.current?.setMarkdown(savedContent);
    setSaveError(null);
  }, [savedContent]);

  const handleSave = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.saveArtifact(owner, repo, docKey, doc, content);
      setSavedContent(content);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [owner, repo, docKey, doc, content, ready]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-base-300 px-4 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-base-content">
            {doc ? doc : "Artifacts"}
          </h2>
          {repoFull && docKey && (
            <p className="truncate text-[11px] text-base-content/50">{repoFull} · {docKey}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {dirty ? (
            <span className="text-[11px] text-warning">Unsaved changes</span>
          ) : savedAt ? (
            <span className="text-[11px] text-success">Saved</span>
          ) : null}
          {dirty && (
            <button
              onClick={handleRevert}
              disabled={saving}
              className="rounded border border-base-300 px-3 py-1 text-xs font-medium text-base-content/80 hover:bg-base-300 disabled:opacity-40"
            >
              Revert
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={!ready || !dirty || saving}
            className="rounded bg-primary px-3 py-1 text-xs font-medium text-primary-content hover:bg-primary/90 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {(error || saveError) && (
        <div className="m-3 rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
          {saveError ? `Save failed: ${saveError}` : error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {!doc ? (
          <div className="flex h-full items-center justify-center p-6 text-sm text-base-content/40">
            {repoFull
              ? "Select a build asset doc to view or edit."
              : "Enter a repository (owner/repo) to browse its build assets."}
          </div>
        ) : loadingDoc ? (
          <div className="p-6 text-sm text-base-content/50">Loading…</div>
        ) : (
          <MDXEditor
            ref={editorRef}
            key={`${owner}/${repo}/${docKey}/${doc}`}
            markdown={content}
            onChange={(md) => setContent(md)}
            className="dark-theme"
            contentEditableClassName="ll-prose ll-prose-editor"
            plugins={[
              headingsPlugin(),
              listsPlugin(),
              quotePlugin(),
              thematicBreakPlugin(),
              linkPlugin(),
              markdownShortcutPlugin(),
              toolbarPlugin({
                toolbarContents: () => (
                  <>
                    <UndoRedo />
                    <BoldItalicUnderlineToggles />
                    <BlockTypeSelect />
                    <ListsToggle />
                    <CreateLink />
                  </>
                ),
              }),
            ]}
          />
        )}
      </div>
    </div>
  );
}
