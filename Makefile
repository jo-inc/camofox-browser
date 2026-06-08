# Release channel: beta (stable, matches camoufox-js) or alpha (latest, e.g. v150).
# The exact version/release is resolved at fetch time by scripts/resolve-camoufox.js,
# which picks the newest upstream asset for this channel + arch — no manual pin.
# Resolution order: `CHANNEL=...` on the command line / environment wins, else a
# `CHANNEL=` line in a local .env file, else the default below.
DOTENV_CHANNEL := $(shell [ -f .env ] && grep -E '^CHANNEL=' .env | tail -1 | cut -d= -f2- | tr -d '[:space:]')
CHANNEL  ?= $(if $(DOTENV_CHANNEL),$(DOTENV_CHANNEL),beta)

# Auto-detect host architecture; map arm64 (macOS) → aarch64
UNAME_ARCH := $(shell uname -m)
ifeq ($(UNAME_ARCH),arm64)
  ARCH ?= aarch64
else
  ARCH ?= $(UNAME_ARCH)
endif

# Map ARCH to the platform suffixes used by upstream release filenames
ifeq ($(ARCH),aarch64)
  CAMOUFOX_ARCH := arm64
  YTDLP_ARCH    := _aarch64
else
  CAMOUFOX_ARCH := x86_64
  YTDLP_ARCH    :=
endif

# Artifacts are namespaced by channel so switching channels never reuses the
# wrong cached binary.
IMAGE         := camofox-browser:$(CHANNEL)-$(ARCH)
CAMOUFOX_ZIP  := dist/camoufox-$(CHANNEL)-$(ARCH).zip
CAMOUFOX_META := dist/camoufox-$(CHANNEL)-$(ARCH).env
YTDLP_BIN     := dist/yt-dlp-$(ARCH)

YTDLP_URL    := https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$(YTDLP_ARCH)

.PHONY: build build-arm64 build-x86 fetch fetch-arm64 fetch-x86 up down reset clean

## Build the Docker image for the current ARCH (default: x86_64)
build: fetch
	. ./$(CAMOUFOX_META); \
	docker build --no-cache \
	  --build-arg ARCH=$(ARCH) \
	  --build-arg CHANNEL=$(CHANNEL) \
	  --build-arg CAMOUFOX_VERSION=$$CAMOUFOX_VERSION \
	  --build-arg CAMOUFOX_RELEASE=$$CAMOUFOX_RELEASE \
	  --build-arg CAMOUFOX_DECLARED_RELEASE=$$CAMOUFOX_DECLARED_RELEASE \
	  -t $(IMAGE) .

## Convenience targets
build-arm64:
	$(MAKE) build ARCH=aarch64

build-x86:
	$(MAKE) build ARCH=x86_64

## Download both binaries into dist/ for the current ARCH
fetch: $(CAMOUFOX_ZIP) $(YTDLP_BIN)

fetch-arm64:
	$(MAKE) fetch ARCH=aarch64

fetch-x86:
	$(MAKE) fetch ARCH=x86_64

# Resolve the latest Camoufox release for this channel + arch into a sidecar
# .env file (CAMOUFOX_VERSION / CAMOUFOX_RELEASE / CAMOUFOX_DECLARED_RELEASE /
# CAMOUFOX_URL) that the zip download and `build` build-args both consume.
$(CAMOUFOX_META):
	mkdir -p dist
	node scripts/resolve-camoufox.js --channel $(CHANNEL) --arch $(CAMOUFOX_ARCH) > $@

$(CAMOUFOX_ZIP): $(CAMOUFOX_META)
	. ./$(CAMOUFOX_META); \
	echo "Resolved Camoufox $$CAMOUFOX_VERSION-$$CAMOUFOX_RELEASE (declared $$CAMOUFOX_DECLARED_RELEASE) for $(CAMOUFOX_ARCH)"; \
	curl -fSL "$$CAMOUFOX_URL" -o $@

$(YTDLP_BIN):
	mkdir -p dist
	curl -fSL "$(YTDLP_URL)" -o $@

up:
	@if ! docker image inspect $(IMAGE) > /dev/null 2>&1; then \
	  $(MAKE) build; \
	fi
	docker run -d --restart unless-stopped --name camofox-browser -p 9377:9377 $(IMAGE)

down:
	docker stop camofox-browser && docker rm camofox-browser

reset:
	-docker stop camofox-browser 2>/dev/null
	-docker rm camofox-browser 2>/dev/null
	-docker rmi $(IMAGE) 2>/dev/null
	$(MAKE) build

clean:
	rm -rf dist
