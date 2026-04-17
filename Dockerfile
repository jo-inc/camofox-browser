FROM node:20-slim

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
    # Without these, Firefox cannot create WebGL contexts — a major bot detection signal
    libegl1-mesa \
    libgl1-mesa-dri \
    libgbm1 \
    # Xvfb virtual display — runs Camoufox as if on a real desktop (better anti-detection)
    xvfb \
    # Fonts
    fonts-liberation \
    fonts-noto-color-emoji \
    fontconfig \
    # Utils
    ca-certificates \
    unzip \
    curl \
    # yt-dlp runtime dependency
    python3-minimal \
    # VNC stack (only used at runtime when ENABLE_VNC=1; small footprint)
    # x11vnc attaches to the existing Xvfb; novnc + websockify expose it over http
    x11vnc \
    novnc \
    python3-websockify \
    net-tools \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Pre-bake Camoufox browser binary into image via bind mount (downloaded by Makefile)
# Note: unzip returns exit code 1 for warnings (Unicode filenames), so we use || true and verify
RUN --mount=type=bind,source=dist,target=/dist \
    mkdir -p /root/.cache/camoufox \
    && (unzip -q /dist/camoufox-${ARCH}.zip -d /root/.cache/camoufox || true) \
    && chmod -R 755 /root/.cache/camoufox \
    && echo "{\"version\":\"${CAMOUFOX_VERSION}\",\"release\":\"${CAMOUFOX_RELEASE}\"}" > /root/.cache/camoufox/version.json \
    && test -f /root/.cache/camoufox/camoufox-bin && echo "Camoufox installed successfully"

# Install yt-dlp for YouTube transcript extraction (no browser needed)
RUN --mount=type=bind,source=dist,target=/dist \
    install -m 755 /dist/yt-dlp-${ARCH} /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY lib/ ./lib/
COPY scripts/ ./scripts/

# Patch Camoufox's built-in Xvfb launcher to use a usable resolution
# (default is 1x1 which is useless for VNC; anti-detection doesn't depend on resolution)
RUN sed -i 's/"1x1x24"/"1920x1080x24"/g' \
    /app/node_modules/camoufox-js/dist/virtdisplay.js \
    && grep -q '1920x1080x24' /app/node_modules/camoufox-js/dist/virtdisplay.js \
    && echo "Xvfb resolution patched to 1920x1080"

ENV NODE_ENV=production
ENV CAMOFOX_PORT=3000

# 9377: Camofox HTTP API
# 6080: noVNC web interface (only active when ENABLE_VNC=1)
EXPOSE 9377 6080

CMD ["sh", "/app/scripts/start.sh"]
