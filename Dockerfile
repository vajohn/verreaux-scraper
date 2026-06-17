# Native ARM64 build on the Pi. The Playwright base ships Chromium + system
# deps for the matching arch, so we avoid a separate `install --with-deps`.
# IMPORTANT: the tag must match the `playwright` npm version in package.json
# (currently 1.60.0) or the browser the package expects won't be in the image.
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

# Toolchain for native modules (better-sqlite3 compiles from source if no
# prebuilt arm64 binary is available; sharp ships prebuilt arm64 binaries).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript (produces dist/cli/* and dist/pi/*).
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# No `playwright install` here: the v1.60.0-jammy base image already ships the
# matching Chromium, so re-running it only adds a build-time network call.

ENV VERREAUX_ROOT=/work
RUN mkdir -p /work/jobs /work/done /work/state

# Default to the worker; compose overrides command for the api service.
CMD ["node", "scripts/pi-watcher.mjs"]
