# Build: tsc compiles src/ to dist/. The service has no runtime dependencies
# (node:sqlite, node:crypto and fetch are built in), so the final image is just
# Node plus dist/.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=7000
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
COPY assets ./assets
# uid 1000 is the `node` user here and `fred` on the VPS. /data is a volume that
# keeps the SQLite file; the rest of the filesystem can be read-only.
RUN mkdir -p /data && chown 1000:1000 /data
USER 1000:1000
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]
