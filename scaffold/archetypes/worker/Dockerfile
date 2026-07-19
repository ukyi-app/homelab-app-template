# syntax=docker/dockerfile:1
FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS build
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

FROM gcr.io/distroless/base-debian12:nonroot
WORKDIR /app
COPY --from=build /app/app /app/app
USER nonroot
ENTRYPOINT ["/app/app"]
