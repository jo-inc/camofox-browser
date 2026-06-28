VERSION  ?= 150.0.2
# TAG_RELEASE = the suffix in the GitHub *release tag* (v$(VERSION)-$(TAG_RELEASE)).
# FILE_RELEASE_* = the suffix in the asset *filename*, which upstream lets DIFFER
#   from the tag (e.g. v150.0.2-beta.25 tag ships camoufox-150.0.2-alpha.25-lin.arm64.zip
#   and -alpha.26-lin.x86_64.zip). Keep these decoupled or the download 404s.
# For 135.0.1 all three were "beta.24"; v150 splits them per-arch.
TAG_RELEASE       ?= beta.25
FILE_RELEASE_arm64  ?= alpha.25
FILE_RELEASE_x86_64 ?= alpha.26

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
  FILE_RELEASE  := $(FILE_RELEASE_arm64)
else
  CAMOUFOX_ARCH := x86_64
  YTDLP_ARCH    :=
  FILE_RELEASE  := $(FILE_RELEASE_x86_64)
endif

IMAGE        := camofox-browser:$(VERSION)-$(ARCH)
CAMOUFOX_ZIP := dist/camoufox-$(ARCH).zip
YTDLP_BIN    := dist/yt-dlp-$(ARCH)

CAMOUFOX_URL := https://github.com/daijro/camoufox/releases/download/v$(VERSION)-$(TAG_RELEASE)/camoufox-$(VERSION)-$(FILE_RELEASE)-lin.$(CAMOUFOX_ARCH).zip
YTDLP_URL    := https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux$(YTDLP_ARCH)

.PHONY: build build-arm64 build-x86 fetch fetch-arm64 fetch-x86 up down reset clean

## Build the Docker image for the current ARCH (default: x86_64)
build: fetch
	docker build --no-cache \
	  --build-arg ARCH=$(ARCH) \
	  --build-arg CAMOUFOX_VERSION=$(VERSION) \
	  --build-arg CAMOUFOX_RELEASE=$(TAG_RELEASE) \
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
