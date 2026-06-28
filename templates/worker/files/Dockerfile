# syntax=docker/dockerfile:1
# homelab worker 계약: HTTP route/probe 없음. 장기 실행 프로세스만 준비한다.

FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1-distroless AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/dist ./dist
USER 65532:65532
ENTRYPOINT ["bun", "/app/dist/index.js"]
