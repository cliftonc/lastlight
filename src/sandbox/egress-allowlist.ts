/**
 * Single source of truth for sandbox HTTP egress allowlists.
 *
 * Both sandbox backends consume this list:
 *   - gondolin: passed verbatim to `agenticRun({ allowedHttpHosts })` so the
 *     QEMU-layer HTTP interceptor 502s anything off-list.
 *   - docker: nginx-egress + coredns configs are generated from these hosts
 *     at harness boot. Sandbox containers spawn with `--dns <coredns-ip>`;
 *     coredns sinkholes allowlisted hostnames to the nginx firewall IP,
 *     which peeks SNI and tunnels to the real upstream. See
 *     `src/sandbox/egress-firewall-config.ts` for the full architecture.
 *
 * The lists are intentionally split so callers can compose tighter policies
 * (e.g. a read-only profile that doesn't need package registries). The
 * everyday default is `DEFAULT_ALLOWLIST`.
 *
 * ## Convention: every entry matches the apex AND all subdomains
 *
 * `openai.com`  → matches openai.com, api.openai.com, platform.openai.com, …
 * `npmjs.org`   → matches npmjs.org, registry.npmjs.org, auth.npmjs.org, …
 *
 * Bare hostnames only — no leading dot, no `*.` prefix. The config
 * generator emits the right syntax for each backend (nginx's
 * `.example.com` map form, CoreDNS regex `(^|\.)example\.com\.$`).
 *
 * Exact-only matching isn't currently supported because we haven't
 * needed it — every host in the list is one we want apex+subdomain
 * access to. If we ever do, we'd add an explicit type (e.g. an `exact:`
 * prefix) so the loose-by-default convention stays unambiguous.
 *
 * A workflow phase can declare `unrestricted_egress: true` to bypass the
 * allowlist entirely — see `src/workflows` for the phase schema.
 */

/** GitHub HTTPS endpoints used by `git`, `gh`, and agentic-pi's github tools. */
export const GITHUB_HOSTS: readonly string[] = [
  // Covers github.com plus api.github.com, codeload.github.com, raw.…, gist.…
  "github.com",
  // *.githubusercontent.com — release artifacts, raw blobs, avatars.
  "githubusercontent.com",
];

/**
 * LLM provider hosts.
 *
 * Required for the docker backend because `agentic-pi run` executes inside
 * the sandbox container there (`src/sandbox/docker.ts` runs `agentic-pi run
 * --sandbox none`), so the LLM HTTP call originates from inside the
 * container. The gondolin backend runs agentic-pi in the harness process,
 * so the call originates from the host and these hosts aren't strictly
 * required inside the VM — they're kept here so a single allowlist can
 * cover both paths without surprises.
 */
export const PROVIDER_HOSTS: readonly string[] = [
  "anthropic.com",
  "openai.com",
  "openrouter.ai",
];

/**
 * Public package registries the executor may hit during `npm install`,
 * etc. Apex-plus-subdomain matching covers auth / CDN / mirror
 * subdomains without needing separate entries.
 */
export const PACKAGE_REGISTRY_HOSTS: readonly string[] = [
  // npm / yarn / pnpm
  "npmjs.org",
  "yarnpkg.com",
  // Python — pypi.org + files.pythonhosted.org are the two big ones.
  "pypi.org",
  "pythonhosted.org",
  // Rust — static.crates.io, index.crates.io, crates.io itself.
  "crates.io",
  // Go modules — covers proxy.golang.org, sum.golang.org, plus golang.org.
  "golang.org",
  // Ruby
  "rubygems.org",
  // Alpine apk + Debian apt — apex covers the regional mirror subdomains.
  "alpinelinux.org",
  "debian.org",
];

/**
 * Combined allowlist used by both backends when a phase has not opted into
 * unrestricted egress. Order is preserved across imports so generated
 * configs are stable.
 */
export const DEFAULT_ALLOWLIST: readonly string[] = [
  ...GITHUB_HOSTS,
  ...PROVIDER_HOSTS,
  ...PACKAGE_REGISTRY_HOSTS,
];

/**
 * Sentinel value recognized by agentic-pi/gondolin (post the `"*"` patch)
 * meaning "allow every host". Used when a phase sets `unrestricted_egress`.
 *
 * On the docker backend, unrestricted egress routes through the open
 * nginx-egress + coredns-open pair — this sentinel is for gondolin only.
 */
export const ALLOW_ALL_SENTINEL = "*";
