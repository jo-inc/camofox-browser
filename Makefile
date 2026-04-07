VERSION  ?= 135.0.1
RELEASE  ?= beta.24

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

IMAGE        := camofox-browser:$(VERSION)-$(ARCH)
CAMOUFOX_ZIP := dist/camoufox-$(ARCH).zip
YTDLP_BIN    := dist/yt-dlp-$(ARCH)

CAMOUFOX_URL := https://github.com/daijro/camoufox/releases/download/v$(VERSION)-$(RELEASE)/camoufox-$(VERSION)-$(RELEASE)-lin.$(CAMOUFOX_ARCH).zip
YTDLP_URL    := https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$(YTDLP_ARCH)

.PHONY: build build-arm64 build-x86 fetch fetch-arm64 fetch-x86 up down reset clean

## Build the Docker image for the current ARCH (default: x86_64)
build: fetch
	docker build --no-cache \
	  --build-arg ARCH=$(ARCH) \
	  --build-arg CAMOUFOX_VERSION=$(VERSION) \
	  --build-arg CAMOUFOX_RELEASE=$(RELEASE) \
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

$(CAMOUFOX_ZIP):
	mkdir -p dist
	curl -fSL "$(CAMOUFOX_URL)" -o $@

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
