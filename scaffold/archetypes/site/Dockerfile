# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# 품질 게이트는 CI 잡이 아니라 이미지 빌드 안에 둔다(ADR-0001) — 타입 에러 = 빌드 실패.
RUN bun run typecheck
RUN bun run build

# static-web-server(SWS) :2 = scratch 기반 기본 이미지. ENTRYPOINT는 sws 바이너리.
# homelab 차트가 args(--port/--root /public/--page-fallback/--health) 주입. pod securityContext가 nonroot 강제.
FROM ghcr.io/static-web-server/static-web-server:2@sha256:6acea6260b14e08dda986361e42640082fbfaab8d88c327de532bb13a3b22994
COPY --from=build /app/web/dist /public
