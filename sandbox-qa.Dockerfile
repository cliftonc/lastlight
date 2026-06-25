# Browser-QA sandbox image (Tier B) — lastlight-sandbox-qa:latest
#
# This is a SEPARATE, HEAVIER image, built only when headless-browser QA is
# enabled. It extends the lean default sandbox (lastlight-sandbox:latest, built
# by sandbox.Dockerfile) with Playwright + a pinned Chromium and all the system
# libraries Chromium needs on Debian slim.
#
# Everything — the Chromium binary AND its shared-library dependencies — is
# baked at BUILD time. The strict HTTP egress allowlist
# (src/sandbox/egress-allowlist.ts) does NOT permit the Playwright/Chromium
# download CDN, so NOTHING may be fetched at runtime. A QA phase running in this
# image must be able to launch Chromium headless with no network access to the
# outside world (it only ever dials localhost / the repo's dev-server).
#
# Build order matters: this image's FROM depends on the base image existing, so
# build the base first:
#   docker compose --profile build-only build sandbox sandbox-qa
#
# The lean default image (lastlight-sandbox:latest) is unchanged by this file.

FROM lastlight-sandbox:latest

# The base image's entrypoint runs as root and the final stage above leaves the
# build as root, but be explicit: we need root to apt-get install + npm -g.
USER root

# Chromium's runtime shared-library dependencies on Debian slim. This is the set
# `playwright install --with-deps chromium` would apt-get install on a
# Debian/bookworm base, listed explicitly so the install is deterministic and
# auditable (no implicit `--with-deps` network resolution beyond apt).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    libx11-6 \
    libxcb1 \
    libxext6 \
    libxi6 \
    libxtst6 \
    libglib2.0-0 \
    libdbus-1-3 \
    libexpat1 \
    libudev1 \
    fonts-liberation \
    fonts-unifont \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright + Chromium at a FIXED, world-readable browsers path so the
# non-root `agent` user (UID 10001, from the base image) can launch it.
#
# Playwright version pin: 1.49.1 (recent stable on the 1.49.x line). Pinning the
# package version also pins the Chromium revision Playwright downloads, so the
# baked browser is reproducible.
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
RUN npm install -g --no-audit --no-fund playwright@1.49.1 \
 && PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
      npx --yes playwright@1.49.1 install chromium \
 && chmod -R a+rX /opt/playwright-browsers

# Make the global `playwright` package resolvable from an arbitrary cwd by a
# plain `node script.mjs` doing `import('playwright')`, run by the `agent` user.
# /usr/local/lib/node_modules is npm's global modules dir on the node:20 base
# image (npm global prefix = /usr/local) — the same dir agentic-pi is installed
# into by the base image. Setting NODE_PATH lets Node resolve global packages
# without a local node_modules. This must stay consistent with where the
# `npm install -g playwright` above lands.
ENV NODE_PATH=/usr/local/lib/node_modules

# Sanity-check at build time that playwright resolves with the NODE_PATH above
# (NODE_PATH is honoured by the module resolver at process start, so this `node`
# invocation sees it). Fails the build early if the global modules dir is wrong.
RUN node -e "require.resolve('playwright'); console.log('playwright resolves via NODE_PATH=' + process.env.NODE_PATH)"

# Keep the base image's ENTRYPOINT/CMD (root entrypoint → gosu agent). Restore
# the workspace WORKDIR the base image ends on.
WORKDIR /home/agent/workspace
