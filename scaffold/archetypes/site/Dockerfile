# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# 품질 게이트는 CI 잡이 아니라 이미지 빌드 안에 둔다(ADR-0001) — 타입 에러 = 빌드 실패.
RUN bun run typecheck
RUN bun run build

# static-web-server(SWS) :2 = scratch 기반 기본 이미지. ENTRYPOINT는 sws 바이너리.
# homelab 차트가 args(--port/--root /public/--page-fallback/--health) 주입. pod securityContext가 nonroot 강제.
FROM ghcr.io/static-web-server/static-web-server:2
COPY --from=build /app/web/dist /public
