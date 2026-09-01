# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${NODE_IMAGE} AS package-manager
ENV PNPM_HOME=/pnpm
ENV PATH=${PNPM_HOME}:${PATH}
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM package-manager AS development-dependencies
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM package-manager AS production-dependencies
ENV NODE_ENV=production
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

FROM development-dependencies AS build
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app
RUN mkdir -p "${DATA_DIR}" && chown node:node "${DATA_DIR}"
COPY --chown=node:node package.json ./package.json
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD ["node", "--input-type=module", "--eval", "const response = await fetch('http://127.0.0.1:8787/health'); if (!response.ok) process.exit(1)"]
CMD ["node", "dist/main.js"]
