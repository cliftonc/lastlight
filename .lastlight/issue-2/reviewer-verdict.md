# Reviewer Verdict — Issue #2

VERDICT: REQUEST_CHANGES

## Summary

All code changes correctly match the architect plan: classifier, router, CLI, runner permission mapping, workflow YAMLs, skill SKILL.md files, and tests are implemented as specified. Tests pass (289/289, 1 pre-existing todo) and typecheck is clean. One Important bug: `pipx install semgrep` runs as root and installs to `/root/.local/bin`, which has `700` permissions — the sandbox drops to the `agent` user via gosu at runtime, so `agent` cannot read or execute the semgrep binary. `gitleaks` (installed to `/usr/local/bin`) is fine.

## Issues

### Critical
None.

### Important

**semgrep inaccessible to agent user at runtime** (`sandbox.Dockerfile:10-17`)

`pipx install semgrep` runs as root (the default Dockerfile user), writing the binary to `/root/.local/bin/semgrep`. `/root` has permissions `700` (owner: root only). The entrypoint drops to the `agent` user via gosu before executing agent tasks, so `agent` cannot traverse into `/root/.local/bin`. Semgrep will fail silently or with a "permission denied" / "command not found" error at scan time.

Suggested fix — install semgrep to a globally accessible path:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip pipx \
    && PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep \
    && curl -sSfL https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_x64.tar.gz \
       | tar -xz -C /usr/local/bin gitleaks \
    && apt-get purge -y python3-pip \
    && rm -rf /var/lib/apt/lists/*
```

Then remove the `ENV PATH="/root/.local/bin:${PATH}"` line (no longer needed for semgrep; the existing `ENV PATH="/home/agent/.local/bin:${PATH}"` at line 27 already covers the agent's claude CLI).

### Suggestions

- The `explore` intent on a security-labeled issue now routes to `security-feedback` rather than the explore workflow. This matches the plan spec but may surprise maintainers who use `@last-light explore` on a security issue. A nit: the SKILL.md `discuss` classification handles this gracefully, so it's not broken — just a minor behavior change worth documenting.

- `sandbox.Dockerfile` runs `apt-get update` twice (one existing layer, one new layer). Minor layer-cache inefficiency; not a functional issue.

### Nits

- The SKILL.md Slack summary uses severity emojis (🔴 🟠 🟡 🔵). Per project style, emojis are typically avoided. Low priority since this is agent output text, not source code.

## Test Results

```
 RUN  v4.1.4 /home/agent/workspace/lastlight

 Test Files  14 passed (14)
      Tests  289 passed | 1 todo (290)
   Start at  22:48:48
   Duration  2.92s (transform 375ms, setup 0ms, import 798ms, tests 377ms, environment 1ms)
```

TypeScript: `npx tsc --noEmit` exits 0 with no errors.

## Re-review after Fix Cycle 1

VERDICT: APPROVED

The one Important issue raised — semgrep being installed to `/root/.local/bin` and inaccessible to the `agent` user at runtime — is correctly fixed. The fix commit changes the install invocation to `PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin pipx install semgrep`, placing the binary at `/usr/local/bin/semgrep` (world-executable), and removes the now-redundant `ENV PATH="/root/.local/bin:${PATH}"` line. Only `sandbox.Dockerfile` and the tracking files changed; no regressions are possible. Tests remain 289/289 passing, typecheck clean.
