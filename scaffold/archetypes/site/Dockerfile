# syntax=docker/dockerfile:1
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# static-web-server(SWS) :2 = scratch 기반 기본 이미지. ENTRYPOINT는 sws 바이너리.
# homelab 차트가 args(--port/--root /public/--page-fallback/--health) 주입. pod securityContext가 nonroot 강제.
FROM ghcr.io/static-web-server/static-web-server:2
COPY --from=build /app/web/dist /public
