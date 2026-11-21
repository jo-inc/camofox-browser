# Trixie (glibc 2.41), not bookworm (2.36): better-sqlite3 ships an arm64 prebuild
# linked against GLIBC_2.38, so on bookworm it loads and then dies at runtime with
# "version `GLIBC_2.38' not found" the first time a tab is opened. amd64 is
# unaffected because that prebuild targets an older glibc.
FROM node:22-trixie-slim AS camofox-browser

# Pinned Camoufox version for reproducible builds
# Update these when upgrading Camoufox
ARG CAMOUFOX_VERSION=158.0.1
ARG CAMOUFOX_RELEASE=beta.41
ARG TARGETARCH
ARG YT_DLP_VERSION=2026.08.19
ARG YT_DLP_SHA256=1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6

# Install dependencies for Camoufox (Firefox-based)
RUN apt-get update && apt-get install -y \
    # Firefox dependencies
    libgtk-3-0 \
    libdbus-glib-1-2 \
    libxt6 \
    libasound2 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    # Mesa OpenGL/EGL for WebGL support (software rendering via llvmpipe)
    # Without these, Firefox cannot create WebGL contexts -- a major bot detection signal
    # libegl1 -- named libegl1-mesa on bookworm, dropped in trixie
    libegl1 \
    libgl1-mesa-dri \
    libgbm1 \
    # Xvfb virtual display -- runs Camoufox as if on a real desktop (better anti-detection)
    xvfb \
    # Fonts
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
    # Utils
    ca-certificates \
    curl \
    unzip \
    # yt-dlp runtime dependency
    python3-minimal \
    && rm -rf /var/lib/apt/lists/*

# Pre-bake Camoufox browser binary into image (downloaded at build time).
#
# The browser is unpacked once into /opt/camoufox, read-only, and launched in
# place through CAMOUFOX_EXECUTABLE. That path does not depend on the home
# directory or UID, so an arbitrary runtime UID never re-downloads the browser.
# CAMOUFOX_EXECUTABLE also makes the npm postinstall below skip its own fetch.
#
# XDG_CACHE_HOME is the camoufox package's data directory
# (${XDG_CACHE_HOME}/camoufox): the fingerprint model baked after `npm ci`, plus
# the fontconfig and GeoIP files it writes at launch. It is group-0 writable
# (see the runtime user section) for the same reason as /app.
ENV XDG_CACHE_HOME=/opt/camoufox-cache
ENV CAMOUFOX_EXECUTABLE=/opt/camoufox/camoufox-bin

# Note: unzip returns exit code 1 for warnings (Unicode filenames), so we use || true and verify
# -f so a 404 fails here instead of writing "Not Found" into the .zip: without it the
# build dies three commands later on "unzip: cannot find zipfile directory", which
# points at the archive rather than at the URL that was actually wrong. Note the Linux
# BuildKit supplies TARGETARCH; map its names to Camoufox release asset names.
RUN case "${TARGETARCH}" in \
      amd64) CAMOUFOX_ARCH="x86_64" ;; \
      arm64) CAMOUFOX_ARCH="arm64" ;; \
      *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/camoufox ${XDG_CACHE_HOME}/camoufox \
    && curl -fL -o /tmp/camoufox.zip "https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.${CAMOUFOX_ARCH}.zip" \
    && (unzip -q /tmp/camoufox.zip -d /opt/camoufox || true) \
    && rm /tmp/camoufox.zip \
    && echo "{\"version\":\"${CAMOUFOX_VERSION}\",\"release\":\"${CAMOUFOX_RELEASE}\"}" > /opt/camoufox/version.json \
    && chmod -R a+rX,go-w /opt/camoufox \
    && test -x "${CAMOUFOX_EXECUTABLE}" \
    && grep -qx "Version=${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}" /opt/camoufox/application.ini \
    && echo "Camoufox installed successfully"

# yt-dlp is installed and verified by the enabled YouTube plugin hook below.

WORKDIR /app

COPY package.json package-lock.json postinstall.js ./
COPY lib/camoufox-download.js ./lib/
COPY scripts/ ./scripts/
# better-sqlite3 has no prebuild matching this node/arch, so npm ci falls back to
# `node-gyp rebuild`, which fails on node:*-slim with "Error: not found: make".
# Install a toolchain for the build and purge it in the same layer so it does not
# land in the image. Independent of the glibc issue noted at the FROM line: this
# one fails at build time on any Debian release, that one at runtime on bookworm.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && npm ci --omit=dev \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/*

# The camoufox package generates fingerprints from fpgen's model, which it would
# otherwise download on the first launch. Importing camoufox first points fpgen
# at ${XDG_CACHE_HOME}/camoufox/fpgen; ensureModel verifies the pinned sha256.
RUN node --input-type=module -e "import 'camoufox'; import { ensureModel } from 'fpgen-js'; await ensureModel();"

COPY server.js ./
COPY camofox.config.json ./
COPY lib/ ./lib/
# lib/cookies.js is a compatibility re-export from ../mcp/lib/cookies.mjs, so mcp/
# must ship even though the MCP server itself is not run here. Without it the
# persistence plugin dies at load with ERR_MODULE_NOT_FOUND, the server starts
# anyway, /health keeps reporting ok, and no profile is ever written -- i.e. the
# container silently loses the durable-profile feature it exists to provide.
COPY mcp/ ./mcp/
COPY plugins/ ./plugins/
COPY scripts/ ./scripts/

# Install default plugin dependencies (apt packages + post-install hooks)
RUN sh scripts/install-plugin-deps.sh

ENV NODE_ENV=production
ENV CAMOFOX_PORT=9377

EXPOSE 9377

# ---- Non-root / arbitrary-UID runtime (OpenShift-compatible) ----
# By default the image runs as uid 1000 ("camofox") whose PRIMARY group is 0
# (root group). Every path the app reads or writes is group-0 owned and
# group-writable, so an ARBITRARY runtime UID also works as long as it runs with
# GID 0 -- which is exactly OpenShift's contract (unknown high UID, always GID 0).
#
# HOME is pinned to a real, group-0-writable directory. os.homedir() returns
# $HOME when set, so even an arbitrary UID with no /etc/passwd entry (which would
# otherwise make os.homedir() return '/') resolves to /home/camofox, and the
# writable runtime dirs (lib/config.js: $HOME/.camofox/{cookies,uploads,profiles,
# traces}) land somewhere writable. CAMOUFOX_EXECUTABLE (set above) keeps the
# baked, read-only browser binary discoverable no matter the home dir, and
# XDG_CACHE_HOME keeps the camoufox package's data directory out of $HOME.
ENV HOME=/home/camofox
# The node base image ships a "node" user at uid 1000; remove it so we can claim
# uid 1000 for the camofox runtime user (primary group 0).
RUN userdel -r node 2>/dev/null || true \
    && useradd -u 1000 -g 0 -m -d /home/camofox -s /usr/sbin/nologin camofox \
    && mkdir -p /home/camofox/.camofox/cookies \
               /home/camofox/.camofox/uploads \
               /home/camofox/.camofox/profiles \
               /home/camofox/.camofox/traces \
    && chgrp -R 0 /home/camofox /app ${XDG_CACHE_HOME} \
    && chmod -R g=u /home/camofox /app ${XDG_CACHE_HOME}

USER 1000

CMD ["sh", "-c", "node --max-old-space-size=${MAX_OLD_SPACE_SIZE:-128} server.js"]

# Optional: rebuild plugin deps after adding third-party plugins
# Usage: docker build --target with-plugins -t camofox-browser .
FROM camofox-browser AS with-plugins
# install-plugin-deps.sh installs apt packages and runs post-install hooks, which
# need root. The base stage ends as USER 1000, so switch back to root for the
# install, re-apply group-0 ownership/perms to any newly copied plugin files, then
# drop back to the non-root default so the final image still runs unprivileged.
USER root
COPY plugins/ ./plugins/
COPY camofox.config.json ./
COPY scripts/install-plugin-deps.sh /tmp/install-plugin-deps.sh
RUN /tmp/install-plugin-deps.sh && rm /tmp/install-plugin-deps.sh \
    && chgrp -R 0 /app && chmod -R g=u /app
USER 1000
