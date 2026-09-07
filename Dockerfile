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
FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r build
# Self-contained prod deployment of the agent package (built dist + prod deps).
RUN pnpm --filter @zeroroot-ai/zerocool deploy --prod --legacy /app

# ---- runtime: node + the opencode CLI the agent spawns + the deployed agent ----
FROM node:22.23.2-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS runtime
ENV NODE_ENV=production \
    ZEROCOOL_OPENCODE_BIN=opencode \
    ZEROCOOL_SEMGREP_BIN=semgrep \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    ZEROCOOL_AGENT_NAME=zerocool
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
COPY tools/semgrep/requirements.txt /tmp/semgrep-requirements.txt
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages --require-hashes -r /tmp/semgrep-requirements.txt \
 && rm /tmp/semgrep-requirements.txt \
 && apt-get purge -y --auto-remove python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && semgrep --version
COPY --from=build /app /app
WORKDIR /app
RUN useradd -u 65532 -m zerocool
USER 65532:65532
# GIBSON_PLATFORM_URL (required) + GIBSON_BOOTSTRAP_TOKEN are supplied at deploy time.
ENTRYPOINT ["node", "dist/serve-agent.js"]
