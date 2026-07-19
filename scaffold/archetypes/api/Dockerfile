# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
FROM oven/bun:1.3.14 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# 품질 게이트는 CI 잡이 아니라 이미지 빌드 안에 둔다(ADR-0001) — 어떤 경로로 빌드해도 우회 불가.
# 타입 에러·테스트 실패 = 빌드 실패 = GHCR push 도달 못 함.
# 게이트는 raw 커맨드가 아니라 package.json 스크립트를 경유한다 — 앱이 test/typecheck 스크립트를
# 바꾸면(커버리지, 러너 교체) 게이트가 그 정의를 그대로 따라가야 하므로 스크립트가 곧 seam이다.
RUN bun run typecheck
RUN bun run test
RUN bun run build

FROM gcr.io/distroless/base-debian12:nonroot@sha256:6c806311d31c11d364a8d13a022af5a48f29e43bd585ad6b51f1bb447f83d239
WORKDIR /app
COPY --from=build /app/app /app/app
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/app"]
