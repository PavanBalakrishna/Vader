# ─────────────────────────────────────────────────────────────────────────────
#  LORD-V4D3R — container image
#
#  Runs server/src/index.js, which serves the console and (in bridge mode) the
#  Claude Agent SDK. Defaults are chosen for a public host:
#
#    • binds 0.0.0.0, because a container's loopback is reachable by nobody
#    • honours $PORT, because Render/Fly/Heroku assign one and route to it
#    • V4D3R_MODE therefore defaults to `static` — the console with no
#      credential of its own, exactly what GitHub Pages serves. Visitors bring
#      their own key. Set V4D3R_MODE=bridge *and* V4D3R_ACCESS_TOKEN to run the
#      Agent SDK on your own credential instead; the server refuses to start
#      with one and not the other.
#
#  Build:  docker build -t lord-v4d3r .
#  Run:    docker run --rm -p 8787:8787 lord-v4d3r
# ─────────────────────────────────────────────────────────────────────────────

# ---------------------------------------------------------------- deps ------
FROM node:22-slim AS deps

WORKDIR /app

# Copied on their own so this layer is cached until the dependencies actually
# change — the source below changes far more often than they do.
COPY package.json package-lock.json ./

# `npm ci` from the lockfile: reproducible, and it fails loudly rather than
# silently resolving something newer. Dev deps are esbuild only, and the
# vendored SDK bundle it produces is committed, so there is nothing to build.
RUN npm ci --omit=dev && npm cache clean --force

# ------------------------------------------------------------- runtime ------
FROM node:22-slim AS runtime

# tini as PID 1 does two jobs that matter here: it forwards SIGTERM (a bare
# node process as PID 1 ignores it, so the platform's graceful stop would time
# out into a SIGKILL), and it reaps the subprocesses the Agent SDK spawns.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

# A container that only listens on loopback is a container nobody can reach.
# See the mode note at the top for why this is not a hole.
ENV V4D3R_HOST=0.0.0.0

# Local default only; $PORT from the platform takes precedence (config.js).
ENV V4D3R_PORT=8787

# The Agent SDK writes session state under $HOME.
ENV HOME=/home/node

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node web ./web

USER node

EXPOSE 8787

# Uses the same endpoint the platform's own health check hits, so a container
# that reports healthy here is one that will pass there too.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.V4D3R_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/src/index.js"]
