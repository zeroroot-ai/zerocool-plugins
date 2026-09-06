# syntax=docker/dockerfile:1
# Container image for the zerocool AGENT (kind=agent dispatched shape, ADR-0006):
# an OUTBOUND worker that registers with the Gibson daemon (GIBSON_PLATFORM_URL)
# and drives opencode headless for each dispatched Task. It listens on no port.
# Built from source; consumed by the Gibson platform catalog (ADR-0015) and by
# gitops as an external agent workload. See docs/adr/0006 + zerocool-plugins#33.
ARG NODE_VERSION=22.21.1
ARG OPENCODE_VERSION=1.18.25
# semgrep runs the vendored ruleset for the source-analysis task
# (zerocool-plugins#87). Pinned like opencode: the candidate list for a
# checkout must not change under a Scan mission because a registry moved.
ARG SEMGREP_VERSION=1.175.0

# ---- build: install the workspace and tsc the zerocool package ----
FROM node:${NODE_VERSION}-slim AS build
WORKDIR /src
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
RUN pnpm -r build
# Self-contained prod deployment of the agent package (built dist + prod deps).
RUN pnpm --filter @zeroroot-ai/zerocool deploy --prod --legacy /app

# ---- runtime: node + the opencode CLI the agent spawns + the deployed agent ----
FROM node:${NODE_VERSION}-slim AS runtime
ARG OPENCODE_VERSION
ARG SEMGREP_VERSION
ENV NODE_ENV=production \
    ZEROCOOL_OPENCODE_BIN=opencode \
    ZEROCOOL_SEMGREP_BIN=semgrep \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0 \
    ZEROCOOL_AGENT_NAME=zerocool
# The opencode CLI is the headless driver the agent spawns (ZEROCOOL_OPENCODE_BIN).
RUN npm i -g opencode-ai@${OPENCODE_VERSION} && npm cache clean --force
# semgrep (ZEROCOOL_SEMGREP_BIN): the candidate producer for source analysis.
# git is what semgrep uses to list the files of a checkout; without it every
# file in a git checkout is "not listed by git ls-files" and skipped.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-pip git ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages semgrep==${SEMGREP_VERSION} \
 && apt-get purge -y --auto-remove python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && semgrep --version
COPY --from=build /app /app
WORKDIR /app
RUN useradd -u 65532 -m zerocool
USER 65532:65532
# GIBSON_PLATFORM_URL (required) + GIBSON_BOOTSTRAP_TOKEN are supplied at deploy time.
ENTRYPOINT ["node", "dist/serve-agent.js"]
