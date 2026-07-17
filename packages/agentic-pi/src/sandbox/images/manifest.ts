/**
 * Baked-in manifest for the `default` agentic-pi-dev image.
 *
 * The image is built and released by the monorepo's
 * `.github/workflows/agentic-pi-image.yml`, which tags releases on
 * `image-v*` (independent from the monorepo npm `v*` stream). After
 * cutting an `image-v<x.y.z>` release, copy the per-arch URLs and
 * sha256s from the release's `manifest.json` into the placeholders
 * below and ship a new npm version.
 *
 * The sha256 is the authoritative signature — the loader verifies it
 * before extracting. Reproducibility across rebuilds is best-effort
 * (depends on Alpine mirror state), not guaranteed.
 */

export interface ImageArchive {
  url: string;
  sha256: string;
  /** Size hint used for download progress / sanity check. Optional. */
  uncompressedBytes: number;
}

export interface ImageManifest {
  name: string;
  version: string;
  archives: {
    aarch64: ImageArchive;
    x86_64: ImageArchive;
  };
}

// Pinned to image-v0.1.0 (first published release). Bump in lockstep
// with new image-v* releases — copy the published manifest.json
// verbatim. `uncompressedBytes` is informational only; the sha256 is
// the load-bearing check.
export const DEFAULT_IMAGE_MANIFEST: ImageManifest = {
  name: "agentic-pi-dev",
  version: "0.1.0",
  archives: {
    aarch64: {
      url: "https://github.com/nearform/lastlight/releases/download/image-v0.1.0/agentic-pi-dev-aarch64.tar.gz",
      sha256: "4748471c473f6cb911b19e6b03c76a56d2ddc7ea865f96f9bc6652236da4a6c2",
      uncompressedBytes: 353131419,
    },
    x86_64: {
      url: "https://github.com/nearform/lastlight/releases/download/image-v0.1.0/agentic-pi-dev-x86_64.tar.gz",
      sha256: "438a0464bea625e4ef370473648a895c07a1871c9d1b9e6a9b3134f91b1b12a4",
      uncompressedBytes: 378520500,
    },
  },
};

export function isManifestPublished(m: ImageManifest = DEFAULT_IMAGE_MANIFEST): boolean {
  return m.archives.aarch64.sha256.length === 64 && m.archives.x86_64.sha256.length === 64;
}
