# Trixie (glibc 2.41), not bookworm (2.36): better-sqlite3 ships an arm64 prebuild
# linked against GLIBC_2.38, so on bookworm it loads and then dies at runtime with
# "version `GLIBC_2.38' not found" the first time a tab is opened. amd64 is
# unaffected because that prebuild targets an older glibc.
FROM node:22-trixie-slim AS camofox-browser

# Pinned Camoufox version for reproducible builds
# Update these when upgrading Camoufox
ARG CAMOUFOX_VERSION=135.0.1
ARG CAMOUFOX_RELEASE=beta.24
ARG ARCH=x86_64

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

# Pre-bake Camoufox browser binary into image (downloaded at build time)
# Note: unzip returns exit code 1 for warnings (Unicode filenames), so we use || true and verify
# -f so a 404 fails here instead of writing "Not Found" into the .zip: without it the
# build dies three commands later on "unzip: cannot find zipfile directory", which
# points at the archive rather than at the URL that was actually wrong. Note the Linux
# arm asset is named lin.arm64.zip -- pass --build-arg ARCH=arm64, not aarch64.
RUN mkdir -p /root/.cache/camoufox \
    && curl -fL -o /tmp/camoufox.zip "https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.${ARCH}.zip" \
    && (unzip -q /tmp/camoufox.zip -d /root/.cache/camoufox || true) \
    && rm /tmp/camoufox.zip \
    && chmod -R 755 /root/.cache/camoufox \
    && echo "{\"version\":\"${CAMOUFOX_VERSION}\",\"release\":\"${CAMOUFOX_RELEASE}\"}" > /root/.cache/camoufox/version.json \
    && test -f /root/.cache/camoufox/camoufox-bin && echo "Camoufox installed successfully"

# Install yt-dlp for YouTube transcript extraction (no browser needed)
RUN curl -L -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
    && chmod 755 /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json package-lock.json ./
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

CMD ["sh", "-c", "node --max-old-space-size=${MAX_OLD_SPACE_SIZE:-128} server.js"]

# Optional: rebuild plugin deps after adding third-party plugins
# Usage: docker build --target with-plugins -t camofox-browser .
FROM camofox-browser AS with-plugins
COPY plugins/ ./plugins/
COPY camofox.config.json ./
COPY scripts/install-plugin-deps.sh /tmp/install-plugin-deps.sh
RUN /tmp/install-plugin-deps.sh && rm /tmp/install-plugin-deps.sh
