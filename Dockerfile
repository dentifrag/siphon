# syntax=docker/dockerfile:1

# --- Build stage: install deps, build web UI + bundle server ---
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run web:build && npm run server:build

# --- Runtime stage: production deps + built artifacts + rclone engine ---
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    DOWNLOAD_DIR=/downloads \
    DATA_DIR=/data \
    WEB_DIR=/app/dist-web \
    HOME=/data
# The download engine is rclone. Install the official static build so the
# container never needs to fetch it at runtime.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip \
    && arch="$(dpkg --print-architecture)" \
    && case "$arch" in \
         amd64) rcarch=amd64 ;; \
         arm64) rcarch=arm64 ;; \
         *) rcarch=amd64 ;; \
       esac \
    && curl -fsSL "https://downloads.rclone.org/rclone-current-linux-${rcarch}.zip" -o /tmp/rclone.zip \
    && unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/rclone \
    && apt-get purge -y unzip \
    && apt-get autoremove -y \
    && rm -rf /tmp/rclone.zip /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Install production dependencies only (no dev/optional deps needed at runtime).
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY --from=build /app/dist-web ./dist-web
COPY --from=build /app/dist-server ./dist-server
VOLUME ["/downloads", "/data"]
EXPOSE 8080
CMD ["node", "dist-server/index.cjs"]
