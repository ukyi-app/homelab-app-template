# syntax=docker/dockerfile:1
# homelab service 계약: :8080 HTTP, GET /health.

FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1-distroless AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080
COPY --from=builder /app/dist ./dist
EXPOSE 8080
USER 65532:65532
ENTRYPOINT ["bun", "/app/dist/index.js"]
