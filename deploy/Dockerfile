# syntax=docker/dockerfile:1.9
#
# Recueil server image.
#
# Build context is the repository root, not deploy/:
#
#   docker build -f deploy/Dockerfile --target runtime -t recueil:dev .
#
# Target runtime builds the current CLI/API server. No OCR worker command exists.
# Pass --target runtime explicitly in scripted builds.
#
# Debian slim rather than Alpine: SQLite and image handling reach for native modules, and prebuilt
# binaries exist for glibc far more reliably than for musl. The size difference is not worth a
# from-source better-sqlite3 build on every arm64 release.
#
# Container build and synthetic recovery validation are tracked in spec/refinement-2026-10.md.
# This file does not establish a published image or production deployment.

# ------------------------------------------------------------------------------------------------
# base
#
# Node 22 LTS is the reference runtime (CONCEPT.md §5.16). Written out rather than parameterised
# with an ARG, because Dependabot can only see a literal tag.
# ------------------------------------------------------------------------------------------------
FROM node:25-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable

WORKDIR /app

# ------------------------------------------------------------------------------------------------
# builder
# ------------------------------------------------------------------------------------------------
FROM base AS builder

ENV CI=true

# node-gyp's toolchain, for any dependency without a prebuilt binary for this platform. None of it
# reaches the runtime image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        python3 \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Fetch the store from the lockfile alone, so the download layer is invalidated only by a dependency
# change and not by every source edit. This requires pnpm-lock.yaml to be committed; a build that
# fails here is telling you the lockfile is missing, which is also what CI's --frozen-lockfile says.
# The root package.json comes along so that Corepack reads `packageManager` and pins the same pnpm
# the workspace and CI use, rather than whichever version the base image happens to default to.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

ARG RECUEIL_VERSION=0.0.0-dev
ARG RECUEIL_REVISION=unknown
ENV RECUEIL_VERSION=${RECUEIL_VERSION} \
    RECUEIL_REVISION=${RECUEIL_REVISION}

RUN pnpm -r --if-present run build

# pnpm deploy resolves the CLI's workspace dependencies (server, core, schemas, first-party plugins)
# into one self-contained tree with development dependencies dropped. The result has no symlinks
# into the store, so it can be copied into a stage that has no pnpm at all.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm deploy --filter=@recueil/cli --prod /prod/recueil

# ------------------------------------------------------------------------------------------------
# runtime-base
# ------------------------------------------------------------------------------------------------
FROM base AS runtime-base

# tini reaps the children a job runner spawns (OCR, Ghostscript, and anything a plugin shells out
# to) and forwards SIGTERM, so `docker stop` is a clean shutdown rather than a ten-second wait.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# RECUEIL_HOST binds to every interface: the only network the container has is the one the operator
# gave it, and 127.0.0.1 inside a container is unreachable from outside it. Publishing that port to
# the host is docker-compose.yml's decision, not the image's.
ENV NODE_ENV=production \
    RECUEIL_HOST=0.0.0.0 \
    RECUEIL_PORT=3000 \
    RECUEIL_DATABASE_URL=file:/data/recueil.sqlite \
    RECUEIL_STORAGE_PATH=/data/storage \
    RECUEIL_LOG_LEVEL=info

# `node` (uid 1000) comes with the base image. Anything mounted at /data must be writable by it;
# The documented Compose path uses a named volume with the image's initialized ownership.
COPY --from=builder --chown=node:node /prod/recueil /app

# One volume holds the database, content-addressed store and extraction scratch space.
# Follow deploy/README.md for consistent CLI backup/verify/restore, separately retained snapshots
# and private configuration/key backups; a raw copy of a live database is not a verified backup.
RUN mkdir -p /data/storage /data/scratch \
    && chown -R node:node /data
VOLUME ["/data"]

# Resolve the launcher from the deployed package's own manifest rather than hard-coding a path into
# apps/cli. If the CLI stops declaring a `recueil` bin, this fails at build time with a readable
# reason instead of producing an image whose entrypoint is not there.
RUN node <<'RESOLVE_BIN'
const fs = require('node:fs');
const manifest = require('/app/package.json');
const bin = typeof manifest.bin === 'string' ? manifest.bin : (manifest.bin || {}).recueil;
if (!bin) {
  console.error('The deployed package declares no `recueil` bin, so this image has no entrypoint.');
  console.error('Add one to apps/cli/package.json, or change deploy/Dockerfile to match.');
  process.exit(1);
}
fs.writeFileSync('/usr/local/bin/recueil', `#!/bin/sh\nexec node /app/${bin} "$@"\n`, { mode: 0o755 });
RESOLVE_BIN

EXPOSE 3000

# /health is the readiness contract (CONCEPT.md §5.15) and Phase 0's exit criterion. fetch is global
# in Node 22, so this needs no curl in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "const port=process.env.RECUEIL_PORT||3000;fetch('http://127.0.0.1:'+port+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

USER node

ENTRYPOINT ["/usr/bin/tini", "--", "recueil"]
CMD ["serve"]

# ------------------------------------------------------------------------------------------------
# runtime — the published image
# ------------------------------------------------------------------------------------------------
FROM runtime-base AS runtime

ARG RECUEIL_VERSION=0.0.0-dev
ARG RECUEIL_REVISION=unknown
# The runtime is a sibling of builder, so its /health version needs its own ENV.
ENV RECUEIL_VERSION=${RECUEIL_VERSION}

LABEL org.opencontainers.image.title="Recueil" \
      org.opencontainers.image.description="Self-hosted, API-first document and reference manager with reference verification, bibliometrics and systematic-review workflow" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="https://github.com/etabli-dev/etabli-recueil" \
      org.opencontainers.image.documentation="https://github.com/etabli-dev/etabli-recueil/blob/main/deploy/README.md" \
      org.opencontainers.image.version="${RECUEIL_VERSION}" \
      org.opencontainers.image.revision="${RECUEIL_REVISION}"
