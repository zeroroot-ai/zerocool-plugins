# syntax=docker/dockerfile:1
# Container image for the zerocool AGENT (kind=agent dispatched shape, ADR-0006):
# an OUTBOUND worker that registers with the Gibson daemon (GIBSON_PLATFORM_URL)
# and drives opencode headless for each dispatched Task. It listens on no port.
# Built from source; consumed by the Gibson platform catalog (ADR-0015) and by
# gitops as an external agent workload. See docs/adr/0006 + zerocool-plugins#33.
#
# Every third-party input is pinned by hash (Scorecard Pinned-Dependencies,
# zerocool-plugins#13): the base image by digest, the opencode CLI through
# tools/opencode/package-lock.json (npm ci), and semgrep through
# tools/semgrep/requirements.txt (pip --require-hashes). Dependabot bumps
# each of them. The candidate list for a checkout must not change under a
# Scan mission because a registry moved (zerocool-plugins#87).

# ---- build: install the workspace and tsc the zerocool package ----
FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS build
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
FROM node:26.8.1-trixie-slim@sha256:c0753125a3789977aefe869cbebccf70e3cfd7ea84ca48547458f02e4f1d7146 AS runtime
ENV NODE_ENV=production \
    ZEROCOOL_OPENCODE_BIN=opencode \
    ZEROCOOL_SEMGREP_BIN=semgrep \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    ZEROCOOL_AGENT_NAME=zerocool
# The npm node bundles is whatever node shipped that day; npm 10's bundled
# tar, minimatch, glob and friends carried fixed CVEs (Trivy, #13).
# tools/npm/package-lock.json pins npm by hash. It replaces the bundled copy
# before anything else installs, and it stays in the image because the MCP server is started through npx.
COPY tools/npm/package.json tools/npm/package-lock.json /opt/npm/
RUN cd /opt/npm \
 && npm ci --omit=dev --no-audit --no-fund \
 && rm -rf /usr/local/lib/node_modules/npm \
 && mv /opt/npm/node_modules/npm /usr/local/lib/node_modules/npm \
 && rm -rf /opt/npm \
 && npm cache clean --force \
 && npm --version
# The opencode CLI is the headless driver the agent spawns (ZEROCOOL_OPENCODE_BIN).
COPY tools/opencode/package.json tools/opencode/package-lock.json /opt/opencode/
RUN cd /opt/opencode \
 && npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && ln -s /opt/opencode/node_modules/.bin/opencode /usr/local/bin/opencode \
 && opencode --version
# semgrep (ZEROCOOL_SEMGREP_BIN): the candidate producer for source analysis.
# git is what semgrep uses to list the files of a checkout; without it every
# file in a git checkout is "not listed by git ls-files" and skipped.
# semgrep lives in its own venv: the hash-pinned set must not fight the
# modules Debian's own python3 packages install (pip refuses to replace a
# Debian-owned `packaging`). The venv's pip is removed once it has installed.
COPY tools/semgrep/requirements.txt /tmp/semgrep-requirements.txt
RUN apt-get update \
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
# GIBSON_PLATFORM_URL (required) + GIBSON_BOOTSTRAP_TOKEN are supplied at deploy time.
ENTRYPOINT ["node", "dist/serve-agent.js"]
