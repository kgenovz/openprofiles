# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS deps
# Build tools for native modules (better-sqlite3) when no prebuilt binary
# matches the platform; only this stage has them, the final image stays slim.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=7000
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY src ./src
COPY assets ./assets
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
