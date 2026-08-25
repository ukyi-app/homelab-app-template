# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
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
# ⚠️ TARGETARCH에 기본값을 주지 말 것 — stage-level ARG 기본값은 BuildKit predefined platform arg를
#   이겨서, 잘못된 아키텍처 바이너리를 담은 이미지를 조용히 만든다(ukyi-app/files·trip-mate-api와 같은
#   규율 — 실측: arm64 하드코딩 시절 amd64 leg가 aarch64 바이너리를 담고 exec format error로 죽었다).
#   비워두면 아래 case가 exit 1로 막는다. 빌드 스테이지는 $BUILDPLATFORM 네이티브 고정이라(FROM 참조)
#   typecheck·test는 QEMU를 타지 않고, bun build --compile이 --target으로 타깃 아치를 크로스컴파일한다.
#   ★`&& bun run build` 형태를 유지할 것 — scaffold.ts의 게이트 추출기가 `&&` 조각의 `bun run <s>`만
#   게이트로 센다(`;` 연결이면 build 게이트가 추출에서 사라져 문서↔코드 가드가 스캐폴드를 죽인다 — 실측).
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      arm64) export BUN_COMPILE_TARGET=bun-linux-arm64 ;; \
      amd64) export BUN_COMPILE_TARGET=bun-linux-x64 ;; \
      *) echo "지원하지 않는 TARGETARCH='$TARGETARCH' — arm64|amd64만 지원" >&2; exit 1 ;; \
    esac \
  && bun run build

FROM gcr.io/distroless/base-debian12:nonroot@sha256:7f0c72cd138b442ae0deeb69c08b1acf5525439ba251a49ad93c320a061567e5
WORKDIR /app
COPY --from=build /app/app /app/app
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/app/app"]
