FROM node:20-slim

# Pinned Camoufox version for reproducible builds
# Update these when upgrading Camoufox
ARG CAMOUFOX_VERSION=135.0.1
ARG CAMOUFOX_RELEASE=beta.24
ARG TARGETARCH

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
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*


# Pre-bake Camoufox browser binary into image
# This avoids downloading at runtime and pins the version
# Note: unzip returns exit code 1 for warnings (Unicode filenames), so we use || true and verify
# TARGETARCH is injected by Docker buildx as "amd64"/"arm64"; Camoufox uses "x86_64"/"aarch64"
RUN case "${TARGETARCH}" in \
      arm64) CAMOUFOX_ARCH=aarch64 ;; \
      amd64|"") CAMOUFOX_ARCH=x86_64 ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac \
    && CAMOUFOX_URL="https://github.com/daijro/camoufox/releases/download/v${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}/camoufox-${CAMOUFOX_VERSION}-${CAMOUFOX_RELEASE}-lin.${CAMOUFOX_ARCH}.zip" \
    && mkdir -p /root/.cache/camoufox \
    && curl -L -o /tmp/camoufox.zip "${CAMOUFOX_URL}" \
    && (unzip -q /tmp/camoufox.zip -d /root/.cache/camoufox || true) \
    && rm /tmp/camoufox.zip \
    && chmod -R 755 /root/.cache/camoufox \
    && echo "{\"version\":\"${CAMOUFOX_VERSION}\",\"release\":\"${CAMOUFOX_RELEASE}\"}" > /root/.cache/camoufox/version.json \
    && test -f /root/.cache/camoufox/camoufox-bin && echo "Camoufox installed successfully"

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY lib/ ./lib/
COPY plugins/ ./plugins/
COPY scripts/ ./scripts/

# Install default plugin dependencies (apt packages + post-install hooks)
# Default plugins are shipped in plugins/ and listed in openclaw.plugin.json
RUN scripts/install-plugin-deps.sh

ENV NODE_ENV=production
ENV CAMOFOX_PORT=9377

EXPOSE 9377

CMD ["sh", "-c", "node --max-old-space-size=${MAX_OLD_SPACE_SIZE:-128} server.js"]

# Optional: rebuild plugin deps after adding third-party plugins
# Usage: docker build --target with-plugins -t camofox-browser .
FROM camofox-browser AS with-plugins
COPY scripts/install-plugin-deps.sh /tmp/install-plugin-deps.sh
RUN /tmp/install-plugin-deps.sh && rm /tmp/install-plugin-deps.sh
