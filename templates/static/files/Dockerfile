# syntax=docker/dockerfile:1
# homelab static 계약: Vite 산출물(dist)을 /public에 넣고 SWS가 /health + SPA fallback을 제공한다.

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY index.html vite.config.ts ./
COPY public ./public
COPY src ./src
RUN pnpm build

FROM ghcr.io/static-web-server/static-web-server:2
COPY --from=builder --chown=65532:65532 /app/dist /public
