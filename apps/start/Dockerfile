ARG NODE_VERSION=22.20.0

FROM node:${NODE_VERSION}-slim AS base

# FIX: Bad workaround (https://github.com/nodejs/corepack/issues/612)
ENV COREPACK_INTEGRITY_KEYS=0

RUN corepack enable && apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    openssl \
    libssl3 \
    curl \
    && apt-get clean && \
    rm -rf /var/lib/apt/lists/*

ENV NITRO=1
ENV SELF_HOSTED=1
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

WORKDIR /app

# Workspace - Copy package.json files for caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Apps
COPY apps/start/package.json ./apps/start/
# Packages - Only copy what start app needs
COPY packages/trpc/package.json packages/trpc/
COPY packages/json/package.json packages/json/
COPY packages/common/package.json packages/common/
COPY packages/importer/package.json packages/importer/
COPY packages/payments/package.json packages/payments/
COPY packages/constants/package.json packages/constants/
COPY packages/validation/package.json packages/validation/
COPY packages/integrations/package.json packages/integrations/
COPY packages/sdks/_info/package.json packages/sdks/_info/
COPY patches ./patches
# Copy tracking script to self-hosting dashboard
COPY apps/public/public/op1.js ./apps/start/public/op1.js

# BUILD
FROM base AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (including dev dependencies for build)
RUN pnpm install --frozen-lockfile && \
    pnpm store prune

# Copy source code
COPY apps/start ./apps/start
COPY packages ./packages
COPY tooling ./tooling

# Generate Prisma client and build the app
RUN pnpm --filter start run build

# `@number-flow/react`'s compiled output imports the bare specifier `esm-env`,
# which this workspace aliases to `esm-env-runtime` via a pnpm override (see
# `pnpm.overrides` in the root package.json). That alias resolves during the
# build install, but nitro's traced standalone server bundle
# (apps/start/.output/server/node_modules) only carries the physical
# `esm-env-runtime` package, not the `esm-env` name. At runtime
# `node .output/server/index.mjs` then throws
# `ERR_MODULE_NOT_FOUND: Cannot find package 'esm-env'` while server-rendering
# any page that mounts a NumberFlow component (charts, stat cards, live
# counters), which surfaces to users as a generic "Something went wrong" page.
# Materialize the alias so the bare specifier resolves. No-op once the bundle
# preserves it natively (or if NumberFlow / the override is removed upstream).
RUN set -eux; \
    out="apps/start/.output/server/node_modules"; \
    if [ -d "$out/esm-env-runtime" ] && [ ! -e "$out/esm-env" ]; then \
      cp -r "$out/esm-env-runtime" "$out/esm-env"; \
      test -f "$out/esm-env/package.json"; \
    fi

# PROD - Install only production dependencies
FROM base AS prod

ENV npm_config_build_from_source=true

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-lock.yaml ./
COPY --from=build /app/pnpm-workspace.yaml ./

# Copy package.json files for production install
COPY --from=build /app/apps/start/package.json ./apps/start/
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/packages/trpc/package.json ./packages/trpc/
COPY --from=build /app/packages/auth/package.json ./packages/auth/
COPY --from=build /app/packages/json/package.json ./packages/json/
COPY --from=build /app/packages/common/package.json ./packages/common/
COPY --from=build /app/packages/importer/package.json ./packages/importer/
COPY --from=build /app/packages/payments/package.json ./packages/payments/
COPY --from=build /app/packages/constants/package.json ./packages/constants/
COPY --from=build /app/packages/validation/package.json ./packages/validation/
COPY --from=build /app/packages/integrations/package.json ./packages/integrations/
COPY --from=build /app/packages/sdks/_info/package.json ./packages/sdks/_info/
COPY --from=build /app/patches ./patches

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod && \
    pnpm rebuild && \
    pnpm store prune

# FINAL - Minimal runtime image
FROM base AS runner

ENV NODE_ENV=production
ENV npm_config_build_from_source=true

WORKDIR /app

# Copy workspace files
COPY --from=build /app/package.json ./
COPY --from=build /app/pnpm-workspace.yaml ./

# Copy production node_modules
COPY --from=prod /app/node_modules ./node_modules

# Copy built app with .output directory
COPY --from=build /app/apps/start/.output ./apps/start/.output
COPY --from=build /app/apps/start/dist ./apps/start/dist
COPY --from=build /app/apps/start/package.json ./apps/start/

# Copy necessary packages
COPY --from=build /app/packages/db ./packages/db
COPY --from=build /app/packages/trpc ./packages/trpc
COPY --from=build /app/packages/auth ./packages/auth
COPY --from=build /app/packages/json ./packages/json
COPY --from=build /app/packages/common ./packages/common
COPY --from=build /app/packages/payments ./packages/payments
COPY --from=build /app/packages/constants ./packages/constants
COPY --from=build /app/packages/validation ./packages/validation
COPY --from=build /app/packages/integrations ./packages/integrations
COPY --from=build /app/packages/sdks/_info ./packages/sdks/_info
COPY --from=build /app/tooling/typescript ./tooling/typescript

WORKDIR /app/apps/start

EXPOSE 3000

# Start the Tanstack Start server
CMD ["node", ".output/server/index.mjs"]
