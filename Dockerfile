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

# package.json declares a "prepare" lifecycle script (npm run build) that npm
# runs automatically during `npm ci`. So the TS build inputs (tsconfig + src +
# scripts) MUST be present before `npm ci`, or prepare fails with
# "TS5058: The specified path does not exist: 'tsconfig.build.json'".
# Copying source here means a code change busts the deps cache layer — an
# acceptable trade-off on a rarely-rebuilt Pi for a correct build.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

# `npm ci` installs deps, compiles native addons (better-sqlite3, sharp), and
# runs "prepare" -> `npm run build`, producing dist/cli/* and dist/pi/*.
RUN npm ci

# No `playwright install` here: the v1.60.0-jammy base image already ships the
# matching Chromium, so re-running it only adds a build-time network call.

ENV VERREAUX_ROOT=/work
RUN mkdir -p /work/jobs /work/done /work/state

# Default to the worker; compose overrides command for the api service.
CMD ["node", "scripts/pi-watcher.mjs"]
