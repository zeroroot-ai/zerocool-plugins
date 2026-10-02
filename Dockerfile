# syntax=docker/dockerfile:1
# Container image for the zerocool AGENT (kind=agent dispatched shape, ADR-0006):
# an OUTBOUND worker that registers with the Gibson daemon (GIBSON_PLATFORM_URL)
# and drives opencode headless for each dispatched Task. It listens on no port.
# Built from source; consumed by the Gibson platform catalog (ADR-0015) and by
# gitops as an external agent workload. See docs/adr/0006 + zerocool-plugins#33.
#
# Every third-party input is pinned by hash (Scorecard Pinned-Dependencies,
# zerocool-plugins#13): the base image by digest, the opencode CLI and the
# Gibson MCP server through tools/opencode/package-lock.json (npm ci), and
# semgrep through tools/semgrep/requirements.txt (pip --require-hashes). Dependabot bumps
# each of them. The candidate list for a checkout must not change under a
# Scan mission because a registry moved (zerocool-plugins#87).

# ---- build: install the workspace and tsc the zerocool package ----
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
WORKDIR /src
# Node 25 and later ship no corepack. pnpm comes from tools/pnpm, hash
# pinned, at the version the root package.json names as packageManager.
COPY tools/pnpm/package.json tools/pnpm/package-lock.json /opt/pnpm/
RUN cd /opt/pnpm \
 && npm ci --omit=dev --no-audit --no-fund \
 && ln -s /opt/pnpm/node_modules/.bin/pnpm /usr/local/bin/pnpm \
 && pnpm --version
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r build
# Self-contained prod deployment of the agent package (built dist + prod deps).
RUN pnpm --filter @zeroroot-ai/zerocool deploy --prod --legacy /app

# ---- runtime: node + the opencode CLI the agent spawns + the deployed agent ----
FROM node:26.10.0-trixie-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS runtime
ENV NODE_ENV=production \
    ZEROCOOL_OPENCODE_BIN=opencode \
    ZEROCOOL_MCP_BIN=gibson-mcp \
    ZEROCOOL_SEMGREP_BIN=semgrep \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    ZEROCOOL_AGENT_NAME=zerocool
# The opencode CLI is the headless driver the agent spawns (ZEROCOOL_OPENCODE_BIN),
# and the Gibson MCP server is the one opencode spawns from it (ZEROCOOL_MCP_BIN,
# packages/opencode-gibson/src/mcp-config.ts). Both come from one hash-pinned
# lockfile, so the server is never fetched from the registry at run time.
#
# npm itself leaves the image once these installs are done. Every npm release
# bundles its own copies of undici, ip-address and brace-expansion, and the
# bundled copies lag their fixes by weeks (Trivy, #101). Nothing in this
# image runs npm or npx after the build, so the runtime carries neither.
COPY tools/opencode/package.json tools/opencode/package-lock.json /opt/opencode/
RUN cd /opt/opencode \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/opencode/node_modules/.bin/opencode /usr/local/bin/opencode \
 && ln -s /opt/opencode/node_modules/.bin/gibson-mcp /usr/local/bin/gibson-mcp \
 && opencode --version \
 && gibson-mcp --version \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /root/.npm \
 && test ! -e /usr/local/bin/npm -a ! -e /usr/local/bin/npx -a ! -e /usr/local/lib/node_modules/npm \
 && node --version
# semgrep (ZEROCOOL_SEMGREP_BIN): the candidate producer for source analysis.
# git is what semgrep uses to list the files of a checkout; without it every
# file in a git checkout is "not listed by git ls-files" and skipped.
# semgrep lives in its own venv: the hash-pinned set must not fight the
# modules Debian's own python3 packages install (pip refuses to replace a
# Debian-owned `packaging`). The venv's pip is removed once it has installed.
COPY tools/semgrep/requirements.txt /tmp/semgrep-requirements.txt
# APT_CACHE_BUST + `apt-get upgrade` — why the base packages were stale.
#
# This image ships gzip, libpcre2-8-0 and libsqlite3-0 one Debian point release
# behind, which is 5 of its 10 critical/high Trivy findings. The base is
# digest-pinned, so it is only as current as the day that digest was built, and
# nothing here ever applied the distro's own security updates.
#
# `apt-get upgrade` alone is not enough either: the layer is cached by buildx
# (cache-from: type=gha) on instruction text plus base digest, so it would run
# once and be replayed forever. Measured on gibson-executor the same day — an
# accidental cache-less build produced patched packages, the next cached build
# put them back. The caller passes a value that changes every run.
ARG APT_CACHE_BUST=0
RUN echo "apt refresh ${APT_CACHE_BUST}" >/dev/null \
 && apt-get update \
 && apt-get upgrade -y --no-install-recommends \
 && apt-get install -y --no-install-recommends python3 python3-venv git ca-certificates \
 && python3 -m venv /opt/semgrep \
 && /opt/semgrep/bin/pip install --no-cache-dir --require-hashes -r /tmp/semgrep-requirements.txt \
 && /opt/semgrep/bin/pip uninstall -y pip \
 && rm /tmp/semgrep-requirements.txt \
 && ln -s /opt/semgrep/bin/semgrep /usr/local/bin/semgrep \
 && apt-get purge -y --auto-remove python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && semgrep --version
COPY --from=build /app /app
WORKDIR /app
RUN useradd -u 65532 -m zerocool
USER 65532:65532

# The license text travels with the distribution. Apache-2.0 §4(a) and MIT
# both require the notice to reach every recipient, and a published image is
# a distribution. /licenses is the OCI convention. Each Dockerfile needs its
# own copy: the two images share a base, not a final stage. Last in the stage
# so a change here rebuilds nothing else.
COPY LICENSE /licenses/LICENSE
COPY NOTICE /licenses/NOTICE

# GIBSON_PLATFORM_URL (required) + GIBSON_BOOTSTRAP_TOKEN are supplied at deploy time.
ENTRYPOINT ["node", "dist/serve-agent.js"]
