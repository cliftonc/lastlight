# Plan: Phase B — Custom Gondolin image `agentic-pi-dev`

## Context

Phase A (shipped in 0.1.3) made the sandbox VM actually usable for any
non-trivial agent work: GitHub tokens flow in, arbitrary env vars can
be set via `--sandbox-env`, and the App PEM stays on the host. But the
guest is still gondolin's stock `alpine-base:latest` — no `git`, no
`gh`, no `node`, no `python`, no `rust`. Every agent run that wants to
build, push code, or use the GitHub CLI has to `apk add ...` first,
which costs network round-trips + ~5-15 s on every cold VM.

Phase B builds a custom image, `agentic-pi-dev`, with the development
toolchain baked in. Boot time drops to the cost of QEMU itself; the
agent can `git clone && npm install && cargo build` from the first
turn.

This plan is the standalone spec. Phase A is already on `main`.

## Decisions locked

| Choice | Pick |
| --- | --- |
| Base distro | Alpine (gondolin's native path; OCI bases also supported, not used) |
| Alpine version | 3.23.0 (current stable at planning time) |
| Kernel package | `linux-virt` (gondolin's recommended micro-VM kernel) |
| Toolchain language tier | Conservative LTS: Node 22 LTS, Python 3.12, Rust stable |
| Extra tools | `git`, `github-cli`, `openssh`, `openssh-client`, `bash`, `curl`, `wget`, `jq`, `ripgrep`, `fd`, `file`, `ca-certificates`, `build-base`, `musl-dev` |
| Architectures | Both `aarch64` and `x86_64` |
| Distribution | GitHub Releases on `nearform/agentic-pi`, separate `image-v*` tag stream |
| Image ref | `agentic-pi-dev` (matches gondolin's image-naming convention) |
| Default when `--sandbox gondolin` | Use `agentic-pi-dev` (not stock `alpine-base`) |
| Fallback override | `--sandbox-image gondolin-builtin` for stock alpine, or `<path>` for a local build |

## Architecture

### Image recipe

```
agentic-pi/
  images/
    agentic-pi-dev/
      build-config.json     # gondolin build config (the spec source of truth)
      README.md             # what's in it, how to rebuild locally
```

`build-config.json` shape (target):

```json
{
  "distro": "alpine",
  "alpine": {
    "version": "3.23.0",
    "kernelPackage": "linux-virt",
    "rootfsPackages": [
      "linux-virt",
      "bash",
      "ca-certificates",
      "curl",
      "wget",
      "file",
      "jq",
      "ripgrep",
      "fd",
      "git",
      "github-cli",
      "openssh",
      "openssh-client",
      "build-base",
      "musl-dev",
      "nodejs",
      "npm",
      "python3",
      "py3-pip",
      "rust",
      "cargo"
    ]
  },
  "env": {
    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "LANG": "C.UTF-8"
  },
  "rootfs": {
    "label": "agentic-pi-root"
  }
}
```

No `postBuild.commands` — all tooling comes from alpine packages, so the
build is fully reproducible from this manifest plus the Alpine 3.23
mirror state.

No `arch` field; passed via `--arch` at build time so a single config
drives both arches.

### Local build helper

```
scripts/
  build-image.sh            # wraps `gondolin build` for one or both arches
```

```bash
# Build current host arch into ./images/agentic-pi-dev/out-<arch>/
./scripts/build-image.sh

# Both arches
./scripts/build-image.sh --all

# Specific arch
./scripts/build-image.sh --arch x86_64
```

Pre-requisites it asserts: `gondolin --version`, `lz4`, `qemu-img`,
`cpio`, `e2fsprogs`. Prints a `brew install` / `apt install` hint if
anything is missing.

### CI build pipeline

```
.github/workflows/
  image.yml                 # builds + releases image artifacts
```

Trigger: tag push `image-v*` (separate stream from `v*` so npm
releases and image releases don't collide).

Jobs:

1. `build` (matrix over `arch: [aarch64, x86_64]`, runner: `ubuntu-latest`):
   - Install host tooling: `qemu-system-x86 qemu-system-arm qemu-utils
     lz4 cpio e2fsprogs`.
   - Install gondolin CLI: `npm install -g @earendil-works/gondolin@<pinned>`.
   - Run `gondolin build --arch ${{ matrix.arch }} --config
     images/agentic-pi-dev/build-config.json --output ./out-${{ matrix.arch }}`.
   - Tar the output directory: `agentic-pi-dev-<arch>.tar.gz`.
   - Compute sha256, write to artifact metadata.
   - Upload as a workflow artifact.

2. `release` (depends on `build`):
   - Download both arch artifacts.
   - Compose `manifest.json` listing both archive URLs + sha256s.
   - Create / update a GitHub Release at `image-v<x.y.z>` (from tag).
   - Attach both `.tar.gz` files + `manifest.json`.

We use `softprops/action-gh-release` (or equivalent) for the release
step. No npm publish — these are pure file artifacts.

### Image registry on the agentic-pi side

```
src/sandbox/images/
  manifest.ts               # baked-in default image manifest (URL + sha)
  loader.ts                 # download / verify / cache logic
```

`manifest.ts`:

```ts
export const DEFAULT_IMAGE_MANIFEST = {
  name: "agentic-pi-dev",
  version: "0.1.0",
  archives: {
    aarch64: {
      url: "https://github.com/nearform/agentic-pi/releases/download/image-v0.1.0/agentic-pi-dev-aarch64.tar.gz",
      sha256: "…filled in after image-v0.1.0 ships…",
      uncompressedBytes: 0,
    },
    x86_64: {
      url: "…",
      sha256: "…",
      uncompressedBytes: 0,
    },
  },
} as const;
```

`loader.ts` API:

```ts
export async function ensureImage(name: "default"|"gondolin-builtin"|string): Promise<string>;
// returns an absolute imagePath suitable for VM.create({ sandbox: { imagePath } }),
// or undefined for "gondolin-builtin" (gondolin handles its own default)
```

Behaviour:

- `name === "gondolin-builtin"` → returns `undefined`, gondolin uses its
  built-in `alpine-base:latest`.
- `name === "default"` → resolves to the baked manifest above.
- `name === <absolute path>` → returns it directly, no download.
- For URL-backed images: check `~/.cache/agentic-pi/images/<sha256>/`,
  download if absent, verify sha256, extract, return path. Atomic via
  `<sha256>.tmp/` → rename.
- Network failure → throws with a clear "set `--sandbox-image
  gondolin-builtin` to skip" hint.

### Runner wiring

`src/args.ts`:

```diff
+ --sandbox-image <name>   Image to boot. 'default' (recommended) uses our
+                          agentic-pi-dev image with git/gh/node/python/rust.
+                          'gondolin-builtin' uses stock alpine-base.
+                          Or an absolute path to a local gondolin build dir.
```

`src/run.ts` adds `RunOptions.sandboxImage?: string`.

`src/sandbox/gondolin.ts` adds an `imagePath` parameter to
`buildGondolinSandbox`, passed to `VM.create({ sandbox: { imagePath } })`.

`src/runner.ts` calls `ensureImage(config.sandboxImage ?? "default")`
before `buildSandbox`. Emits a `sandbox_status` field
`image: { name, version, source: "cached"|"downloaded"|"builtin", downloadMs? }`.

### Event-stream additions

`sandbox_status` gains an `image` block:

```jsonl
{
  "type": "sandbox_status",
  "backend": "gondolin",
  "status": {
    "backend": "gondolin",
    "cwd": "/path/to/workspace",
    "guestPath": "/workspace",
    "createMs": 47,
    "envKeys": ["GH_TOKEN", "GITHUB_TOKEN"],
    "image": {
      "name": "agentic-pi-dev",
      "version": "0.1.0",
      "source": "cached"
    }
  },
  …
}
```

## Phasing within Phase B

Five sub-steps, each independently shippable. Total estimated effort
~1-2 working days for B1-B3; B4-B5 are smaller follow-ups.

### B1 — image definition + local build

- Write `images/agentic-pi-dev/build-config.json`.
- Write `scripts/build-image.sh` (host-arch only; `--all` left for B3).
- Build locally on the macOS dev box, verify boot via
  `GONDOLIN_GUEST_DIR=./out-aarch64 gondolin bash`, run every tool
  (`git --version`, `gh --version`, `node --version`, `python3
  --version`, `rustc --version`) to confirm.

### B2 — agentic-pi consumes a local image (no download yet)

- Add `--sandbox-image <path>` and `RunOptions.sandboxImage`.
- Wire through `buildGondolinSandbox` → `VM.create({ sandbox: { imagePath } })`.
- Smoke test: integration test that points at the B1 image dir and runs
  `git --version && gh --version` inside the sandbox via `bash`.
- Ship as 0.2.0-rc.0 or behind an env flag.

### B3 — distribution pipeline

- Write `.github/workflows/image.yml` with both-arch matrix.
- Test on a feature branch first (image-v0.0.1-test tag, throwaway).
- When both-arch builds + a release attaches both artifacts cleanly,
  cut `image-v0.1.0`.
- Capture both `.tar.gz` URLs + sha256s, hand-fill into `manifest.ts`.

### B4 — auto-download default

- Implement `loader.ts` (download, sha256 verify, extract, cache).
- Default `--sandbox-image` to `default` when `--sandbox gondolin` is
  set (was `gondolin-builtin` implicitly until now).
- Add `--sandbox-image gondolin-builtin` as the explicit opt-out.
- Add an integration test that nukes the cache and forces a download.
- Release as 0.2.0.

### B5 — lastlight integration (out of scope for this plan; tracked in
lastlight repo)

- Bump the agentic-pi dep in lastlight to 0.2.x.
- Drop the `apk add` step in any prompts that previously assumed
  bare-alpine.
- Verify `pr-fix` / `build` workflows end-to-end against a real PR.

## Risks & open decisions

| Risk | Mitigation |
| --- | --- |
| Image size growth blows past 1 GB | Audit `rootfsPackages`. The Rust toolchain alone is ~300 MB; drop it from the default and ship a `agentic-pi-dev-rust` variant if needed. |
| Alpine 3.23 mirror changes break reproducibility | The build is best-effort reproducible; the SHA256 in the manifest is the authoritative signature. We don't promise byte-identity across rebuilds. |
| gondolin build CLI changes API across minor versions | Pin `@earendil-works/gondolin` to a specific patch in the image-build workflow. Floating `^` is fine for the agentic-pi runtime dep. |
| Cross-arch builds need Docker | CI runners are Linux; `gondolin build` uses Docker only for x86_64-on-ARM and ARM-on-x86. Two parallel matrix jobs avoid cross-arch entirely. |
| `image-v*` tag pollution in the release UI | Document the dual tag stream (`v*` for npm, `image-v*` for images). Both show in releases but are distinguishable by prefix. |
| Image build job time on free-tier CI | ~10-15 min/arch on `ubuntu-latest`. Acceptable for low frequency (image-v releases happen rarely). |
| First-run download is slow / hits NAT-limited environments | Manifest's `uncompressedBytes` lets us show a progress hint. Provide a `--sandbox-image gondolin-builtin` escape hatch. |

## Critical files to add/touch

| Path | Phase | Why |
| --- | --- | --- |
| `images/agentic-pi-dev/build-config.json` | B1 | source of truth for image contents |
| `images/agentic-pi-dev/README.md` | B1 | rebuild docs |
| `scripts/build-image.sh` | B1 | local-build wrapper |
| `src/args.ts` | B2 | `--sandbox-image` flag |
| `src/run.ts` | B2 | `RunOptions.sandboxImage` |
| `src/sandbox/gondolin.ts` | B2 | accept `imagePath`, pass to `VM.create` |
| `src/sandbox/index.ts` | B2 | thread `sandboxImage` through `BuildSandboxOptions` |
| `src/runner.ts` | B2/B4 | resolve image, emit `sandbox_status.image` |
| `.github/workflows/image.yml` | B3 | CI build + release |
| `src/sandbox/images/manifest.ts` | B3/B4 | baked manifest (filled after image-v0.1.0 ships) |
| `src/sandbox/images/loader.ts` | B4 | download/verify/cache |
| `test/sandbox/loader.test.ts` | B4 | unit tests for cache logic |
| `test/run-sandbox-image.integration.test.ts` | B2+B4 | end-to-end test |

## Verification per phase

- **B1**: `gondolin build … && GONDOLIN_GUEST_DIR=./out gondolin exec —
  'git --version && gh --version && node --version && python3 --version &&
  rustc --version'` returns clean output for all five tools.
- **B2**: `agentic-pi run --sandbox gondolin --sandbox-image
  $(realpath ./images/agentic-pi-dev/out-aarch64)` inside an LLM prompt
  that runs `git --version` returns the version in the assistant's
  reply. Integration test captures this.
- **B3**: `image-v0.1.0` release page lists `agentic-pi-dev-aarch64.tar.gz`,
  `agentic-pi-dev-x86_64.tar.gz`, and `manifest.json`. `sha256sum
  agentic-pi-dev-aarch64.tar.gz` matches the manifest entry.
- **B4**: Fresh `~/.cache/agentic-pi/` → first `agentic-pi run --sandbox
  gondolin` emits `sandbox_status.image.source: "downloaded"` with a
  non-zero `downloadMs`. Second run emits `source: "cached"`.

## Open questions to resolve before B2 starts

1. **Image versioning cadence.** Probably aligned with major changes
   to the toolchain (Node LTS bump, Alpine major). Could pin
   per-agentic-pi-version (every npm 0.x.y maps to one image-vN.M.K).
   Suggest: independent, but minor agentic-pi releases that depend on
   a new image bump are pinned via `manifest.ts`.

2. **Should we sign the artifacts?** GH releases attach a sha256 via
   our manifest. Cosign / sigstore would add provenance attestation,
   matching what npm already does for the npm pkg. Probably skip for
   v1, revisit if anyone asks.

3. **Cache eviction policy.** First version of `loader.ts` keeps every
   image version forever. Add an `agentic-pi clean-cache` subcommand
   or rely on the user to `rm -rf ~/.cache/agentic-pi`? Probably the
   latter for v1.

4. **Behaviour when offline + cache miss.** Throw with a clear hint
   recommending `--sandbox-image gondolin-builtin` as the escape hatch.

5. **Linux user runs gondolin without `/dev/kvm`.** Existing preflight
   check already refuses cleanly. Image work doesn't change this.

When B2 starts: re-confirm (1) and (4), the others can be deferred.
