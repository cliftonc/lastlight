#!/usr/bin/env node
// Copies lastlight/spec/*.md into src/content/spec/ so Astro's content
// collection can render them. src/content/spec/ is GENERATED (gitignored) —
// this script populates it on `prepare` (so a fresh `pnpm install` and IDE
// typegen see it), `predev`, and `prebuild`.
//
// Resolution order for the source directory:
//   1. SPEC_SRC env var (absolute path)
//   2. ../server/spec relative to this app (the in-repo core package,
//      apps/server/spec, since www now lives at apps/www in the monorepo)
//
// If no source is found the script exits 0 with a warning and leaves whatever
// is already in src/content/spec/ (e.g. a prior sync this session) untouched.
// In the monorepo apps/server/spec is always present, so this only bites if it
// is deleted — the build would then render an empty spec section.

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const DEST = join(REPO_ROOT, 'src/content/spec');

function resolveSource() {
  if (process.env.SPEC_SRC) {
    const p = resolve(process.env.SPEC_SRC);
    if (existsSync(p)) return p;
    console.warn(`[sync-spec] SPEC_SRC=${p} not found, ignoring`);
  }
  const sibling = resolve(REPO_ROOT, '..', 'server', 'spec');
  if (existsSync(sibling)) return sibling;
  return null;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, files);
    else if (entry.endsWith('.md')) files.push(p);
  }
  return files;
}

const src = resolveSource();
if (!src) {
  console.warn('[sync-spec] no spec source found; leaving src/content/spec as-is');
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });

// Clean stale destination files so deletes in source propagate.
for (const entry of readdirSync(DEST)) {
  if (entry.endsWith('.md')) rmSync(join(DEST, entry));
}

let copied = 0;
let skipped = 0;
for (const file of walk(src)) {
  const name = file.slice(src.length + 1).replaceAll('/', '__');
  // README.md is the GitHub-facing index for the spec directory. It is not a
  // numbered component page and is not rendered on the website (the website's
  // /spec/ landing page replaces it). Skip it.
  if (name === 'README.md') {
    skipped++;
    continue;
  }
  copyFileSync(file, join(DEST, name));
  copied++;
}

console.log(`[sync-spec] copied ${copied} markdown file(s) from ${src} → src/content/spec/ (skipped ${skipped})`);
