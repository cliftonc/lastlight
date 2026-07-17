# Spike: Gondolin micro-VMs inside agentic-pi

**Goal.** Decide whether agentic-pi should *automatically* sandbox its read/
write/edit/bash tools inside a Gondolin micro-VM, so an orchestrator like
lastlight no longer needs Docker-per-task isolation.

**Two scenarios investigated:**

| Scenario | Gate | Verdict |
| --- | --- | --- |
| **Orchestrator running inside Docker** (lastlight's current deployment) | Must work in a container with no `/dev/kvm` | ❌ Not viable today (Docker-in-Docker / nested virt fails) |
| **Orchestrator running natively** on macOS or Linux host | QEMU + HVF (Mac) or QEMU + KVM (Linux) available directly | ✅ **Works.** Empirically verified on macOS Apple Silicon. |

The rest of this document is split into the two cases.

## Case A: Orchestrator inside Docker — ❌ Not viable today

### TL;DR

- Gondolin is a QEMU-backed micro-VM framework. Without KVM hardware
  acceleration it does not work — confirmed empirically and via upstream
  [issue #51](https://github.com/earendil-works/gondolin/issues/51).
- KVM in Docker requires `--device /dev/kvm` and a Linux host kernel with
  KVM. macOS Docker (Colima / Docker Desktop) exposes no `/dev/kvm` at all
  because it uses Apple's Virtualization.Framework, not KVM.
- The alternative libkrun backend is broken on Linux x86_64 per
  [issue #91](https://github.com/earendil-works/gondolin/issues/91), open
  since April 2026 with no maintainer response.
- The failure mode without KVM is **silent hang** (process pegged at ~95%
  CPU with no output, no Ctrl+C), not a clean error. That alone disqualifies
  it from automatic use.

### Empirical results

#### Test rig

| Aspect | Value |
| --- | --- |
| Host | macOS 26.3, Apple Silicon (arm64) |
| Docker | Docker Engine 29.2.1 via Colima |
| Container backend | macOS Virtualization.Framework (HVF) |
| Probe image | `node:22-slim` + `qemu-system-x86 qemu-system-arm qemu-utils` + `@earendil-works/gondolin@latest` |
| Probe script | `test/gondolin-docker-test/probe.mjs` |

#### Result: container without `/dev/kvm` (the macOS dev / Colima reality)

```
=== environment ===
arch: arm64
/dev/kvm exists: false
qemu-system-x86_64: /usr/bin/qemu-system-x86_64
qemu-system-aarch64: /usr/bin/qemu-system-aarch64
qemu-img: /usr/bin/qemu-img

=== attempting VM.create() with 60s timeout ===
Downloading gondolin guest image (v0.5.0)...
  Guest image installed successfully.
VM ready in 8349ms
TIMEOUT after 60116ms — process hanging on VM boot (matches gondolin#51)
```

`VM.create()` returns `"VM ready"`, but the very next `vm.exec(["/bin/echo",
"hi"])` hangs forever. The VM was never really booted — `VM.create` resolves
on the spawn handshake, not on full guest boot. Without KVM the guest CPU
makes no forward progress.

#### Result: attempt `docker run --device /dev/kvm`

```
docker: Error response from daemon: error gathering device information while
adding custom device "/dev/kvm": no such file or directory
```

Colima's Linux VM does not have `/dev/kvm` — it runs on macOS's
Virtualization.Framework. KVM passthrough is fundamentally unavailable on
macOS hosts.

#### Cold-start cost (when it does start)

- 89 MB guest image downloaded on first run (`gondolin-guest-arm64.tar.gz`,
  v0.5.0). Cached at `~/.cache/gondolin/` afterward.
- `VM.create()` handshake: ~8 seconds on this rig — and that's *before* the
  guest is actually executable.

### Where Gondolin **would** work inside Docker

Theoretically, on a Linux production host with:

1. `/dev/kvm` present on the host (most bare-metal Linux, most non-managed
   VMs that allow nested virt).
2. The container started with `--device /dev/kvm` and `--cap-add SYS_RESOURCE`
   (or `--privileged`).
3. The container image carrying `qemu-system-*` + `qemu-utils` (~120 MB
   added).
4. First-run network access to GitHub Releases to fetch the ~89 MB guest
   image, or that image baked into the Docker layer.

### Why this is a hard "no" for lastlight-in-Docker today

| Requirement | Status |
| --- | --- |
| Works in lastlight's existing macOS dev environment | ❌ No `/dev/kvm` on Mac. |
| Works in Docker Desktop / Colima | ❌ No `/dev/kvm` exposed by either. |
| Works on common managed container hosts (Fly Machines without nested-virt enabled, Cloud Run, GKE Autopilot, ECS Fargate, Render) | ❌ None expose `/dev/kvm`. |
| Works on a self-managed Linux host with explicit `--device /dev/kvm` | ⚠️  Probably — but adds image weight, CAP_SYS_ADMIN-ish requirements, untested in this spike. |
| Fails fast and visibly when unavailable | ❌ Silent hang per upstream #51. |
| Maintainer responsiveness to blocker issues | ❌ #51 open since Feb 2026, #91 since Apr 2026, neither has a maintainer reply. |
| libkrun fallback works | ❌ Broken per #91. |

The "must work inside Docker" gate is the user's stated hard requirement.
With current Gondolin and a macOS-dev / typical-managed-cloud deployment
target, the gate is not met.

### What would unblock the Docker case

We could revisit if any of these change:

1. **Upstream fixes #51** — TCG (software-emulated) fallback that actually
   boots, even if slow. This is the cleanest unlock; it lets the spike
   work everywhere QEMU runs.
2. **A `--device /dev/kvm` path is acceptable** and lastlight commits to
   running on Linux hosts that expose KVM. The container would need a
   bespoke image and lifecycle hooks; we'd lose the "works on Mac dev"
   property.
3. **Gondolin ships a non-VM mode** (e.g. landlock + bind-mount based
   sandbox like Bubblewrap) that gives ~80% of the isolation without
   needing a hypervisor. Not on the roadmap as of this spike.

If any of those happen, the integration code path in this repo is small —
the Pi extension API makes tool overrides one-liners, the example at
`gondolin/host/examples/pi-gondolin.ts` does it in ~300 lines, and we'd
just convert it from `pi -e extension.ts` into an internal `--sandbox
gondolin` flag.

---

## Case B: Orchestrator running natively — ✅ Works

If lastlight runs **directly on the macOS / Linux host** (not inside Docker),
QEMU has direct access to the host hypervisor and Gondolin works as
designed. This is the path Gondolin's authors target — the README literally
says `brew install qemu node && npx @earendil-works/gondolin bash`.

### Empirical results (native macOS, Apple Silicon)

Same probe as Case A, but executed natively after `brew install qemu`:

```
=== environment ===
arch: arm64
/dev/kvm exists: false              ← Mac has no KVM, uses HVF instead
qemu-system-aarch64: /opt/homebrew/bin/qemu-system-aarch64
qemu-img:            /opt/homebrew/bin/qemu-img

=== attempting VM.create() with 30s timeout ===
VM ready in 13744ms
exec result: { ok: true, stdout: 'hello from inside gondolin', exitCode: 0 }
VM closed cleanly
```

`vm.exec(...)` actually executed inside the guest — confirmed by stdout.
Native QEMU on macOS auto-uses Apple's Hypervisor.framework (HVF) for
acceleration without any KVM dependency. The same code path that hangs
forever in a Mac Docker container works clean in ~13s native.

### Latency profile (steady-state, same process, cache warm)

A second probe (`probe-perf.mjs`) measured a hotter path:

| Op | Time |
| --- | --- |
| `VM.create({})` first call in process | 40 ms |
| `VM.create({})` second call | 21 ms |
| 5× `vm.exec(["/bin/echo", "iter N"])` | 1042 ms (≈ 208 ms each) |
| `vm.exec(["/bin/sh", "-c", "ls /etc \| head -10 && uname -a"])` | 2812 ms |
| `vm.close()` | 6 ms |

Two observations:

1. **Cold start is one-shot.** The 13.7s first-VM cost is paid once per
   host boot (probably warm-caching the rootfs in OS page cache). Within
   a process, `VM.create` is ~40 ms.
2. **Per-exec overhead is non-trivial.** ~200 ms minimum per `vm.exec`,
   ~2.8 s for a real shell op. That's the cost of round-tripping through
   the host→guest serial channel. Every Pi tool call inside the sandbox
   will pay this.

### Linux native (untested in this spike, but standard QEMU+KVM)

On a Linux host with KVM (`/dev/kvm` present and readable), `qemu-system-*
-enable-kvm` runs near bare-metal speed. Gondolin should "just work" — it's
the exact path the upstream README documents (`sudo apt install
qemu-system-arm`). Worth a 30-minute follow-up confirmation on whatever
host lastlight would run on, but no reason to expect a different outcome.

### Architectural implications if lastlight goes native

If lastlight stops being a Docker-container deployment and runs as a native
process (systemd unit on Linux, brew service on Mac dev), Gondolin
substitutes for the per-task sandboxing layer:

```
Before (Docker-per-task model)
─────────────────────────────────────
host
└─ lastlight container
   └─ docker-cli → spawn task container
      └─ agentic-pi process
         ├─ Pi SDK (in-process)
         └─ Pi tools execute directly in this container

After (native + Gondolin)
─────────────────────────────────────
host
└─ lastlight process (systemd / brew service)
   └─ agentic-pi child process (one per phase)
      ├─ Pi SDK (in-process)
      └─ Pi tools override → routed to a fresh Gondolin VM
                              (workspace mounted at /workspace)
```

What changes:

| Concern | Docker-per-task | Native + Gondolin |
| --- | --- | --- |
| Per-task isolation | Linux container (namespaces + cgroups) | Full QEMU micro-VM (stronger) |
| GitHub API calls | From inside container | From agentic-pi process (outside VM) |
| Cold-start per task | ~1 s container spawn | ~13 s first task post-boot, ~ sub-second thereafter |
| Per-tool latency | bash runs at host speed | ~200 ms overhead per tool call |
| Network egress control | iptables-based or none | Gondolin's per-request HTTP allowlist + secret injection |
| Macros mac dev story | Works | Works (HVF, no Docker needed) |
| Linux prod | Works (Docker) | Works (KVM) — but needs systemd or equivalent host setup |
| Managed hosts (Cloud Run, Fly, etc.) | Works | Doesn't work — no hypervisor inside their containers |
| Existing deployment | Already shipped | New work: native packaging + service config |
| Resource overhead | One Node process + bash | One Node process + per-task QEMU (~200 MB RSS each) |

### Open architectural questions if you want to go this route

1. **Where do GitHub API calls live?** If `agentic-pi` is outside the VM,
   it holds GitHub credentials. The agent's bash/file ops are sandboxed
   from those creds (good). But a prompt-injection that subverts Pi's
   message handling could still call `github_*` tools — they execute in
   agentic-pi, not the VM. Gondolin's HTTP egress hooks could *also* wrap
   the GitHub HTTPS calls and constrain them by allowlist; worth doing.
2. **Cold-start budget for multi-phase workflows.** Architect → build →
   review = 3 VMs. At 13 s first-boot, that's 40+ s of overhead per task.
   Mitigations: (a) VM pool / snapshot resume — Gondolin supports
   snapshots, untested in this spike; (b) one VM per *task* not per
   *phase*, with the workspace persisting between phases.
3. **Deployment story.** Lastlight is currently a polished `docker-compose
   up` deployment. Going native = new install scripts, systemd unit,
   probably a separate "linux native" install path. Real work — not just
   docs.
4. **Operator footgun: missing QEMU.** Native deployment requires the
   operator to install QEMU. agentic-pi should detect QEMU absence
   *cleanly* (not hang per #51) — would need a defensive `which
   qemu-system-*` probe before `VM.create`.

### Recommendation if you want this

Phase the work, with a clear opt-in flag rather than a default:

1. **Add `--sandbox gondolin` (off by default)** to agentic-pi. Mirrors
   the pi-gondolin example: override read/write/edit/bash with VM-routed
   versions. Emit a `sandbox_status` JSONL event with cold-start
   timings so lastlight can log them.
2. **Pre-flight QEMU probe.** If QEMU is missing OR `/dev/kvm` is absent
   on Linux without HVF / nested-virt accel, refuse to start with a clean
   error pointing at this spike doc. Never let it hang.
3. **Workspace persistence.** Mount the host workspace at `/workspace`
   read-write, the way the upstream example does. Pi's `cwd` tracking
   already understands this convention.
4. **Spike snapshots** for the cold-start cost. Gondolin has `snapshot` /
   `bash --resume` commands; if those drop per-task cold-start from 13 s
   to 1-2 s, the workflow cost story changes substantially.
5. **Defer the lastlight-side native packaging** until step 4 has a
   number. If snapshots don't materially help and the per-task budget
   stays at ~13 s, the Docker-per-task model is still cheaper and the
   stronger isolation may not be worth it.

---

## Spike artifacts (for the next pass at this question)

- `test/gondolin-docker-test/Dockerfile` — the probe image (gitignored,
  lives in /tmp/gondolin-docker-test during the spike).
- `test/gondolin-docker-test/probe.mjs` — VM.create + exec smoke test
  with a 60-second timeout.
- Empirical evidence shows VM.create returns `ready` even when the guest
  is dead. Any future integration must avoid trusting that signal and
  instead probe with a real exec command before returning to the caller.

## Linked upstream issues to watch

- [#51 — gondolin bash hangs indefinitely when /dev/kvm is unavailable](https://github.com/earendil-works/gondolin/issues/51)
- [#91 — libkrun backend: VM.create() fails with virtio bridge ECONNRESET](https://github.com/earendil-works/gondolin/issues/91)
- [#96 — ARM64: crash on any QEMU 8.2.x host due to FEAT_E0PD](https://github.com/earendil-works/gondolin/issues/96)
- [#50 / #53 — OCI image support](https://github.com/earendil-works/gondolin/issues/50)

When (if) #51 closes with a working TCG path, this verdict should be
re-tested with the same probe script.
