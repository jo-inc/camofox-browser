# camofox-browser

## Tech Stack

- Runtime: Node.js 20
- Framework: Express (REST API)
- Browser Engine: Camoufox (Firefox fork with C++-level fingerprint spoofing)
- Container: Docker (multi-arch: linux/amd64, linux/arm64)

## Structure

```
server.js        # Express entry point
lib/             # Core modules (browser, routes, utils)
tests/           # Jest test suite
scripts/         # Build/utility scripts
Dockerfile       # Multi-arch image build
docker-compose.yml
```

## Conventions

- Commits: conventional commits (`fix(scope): desc`)
- Branch: `fix/*`, `feature/*` from `main`
- Tests: Jest (`npm test`)

## Scripts

- `npm start` — start server
- `npm test` — run tests
- `docker build` — build image

## Docker Multi-Arch Notes

- `TARGETARCH` is injected by Docker buildx as `amd64` or `arm64`
- Camoufox release filenames use `x86_64` and `aarch64` — map explicitly in `RUN` steps
- Do NOT use `ARG` interpolation for arch-dependent URLs; use a `case` statement in `RUN`

## Setup

```bash
npm install
cp .env.example .env  # if applicable
npm start
```
