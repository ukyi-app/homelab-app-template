# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# 품질 게이트는 CI 잡이 아니라 이미지 빌드 안에 둔다(ADR-0001) — 타입 에러 = 빌드 실패.
RUN bun run typecheck
RUN bun run build

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=build /app/app /app/app
USER nonroot
ENTRYPOINT ["/app/app"]
