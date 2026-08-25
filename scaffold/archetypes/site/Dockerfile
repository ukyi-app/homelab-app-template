# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# ⚠️ BUILDPLATFORM 고정을 빼지 말 것. site 산출물(web/dist)은 정적 자산이라 아키텍처 중립이고,
#   그래서 이 아키타입만 TARGETARCH 파라미터화가 없다(homelab doctor의 COMPILED_ARCHETYPES 밖 —
#   크로스컴파일할 바이너리가 없으니 그 검사는 여기 해당하지 않는다). 바로 그 중립성이 이 줄의 근거다:
#   고정하지 않으면 이 스테이지가 타깃마다 한 번씩 돌고, amd64 leg는 reusable-app-build에서 QEMU를 탄다
#   — 같은 결과를 두 번 만들면서 한 번은 에뮬레이터 위에서 만드는 셈이다.
#   그 자리는 실제로 무는 자리다: bun 1.4.0은 QEMU 아래서 JSC 힙 블록을 확보하지 못해 RSS 24MB 시점에
#   MemoryExhaustion으로 abort한다(ukyi-app/page 실측 — `tsc --noEmit`이 죽었고, 여기 `bun run typecheck`가
#   같은 호출이다. BUN_JSC_useJIT=0·forceRAMSize 우회는 둘 다 통하지 않았다). Renovate가 이 태그를
#   1.4.x로 올리는 순간 그 벽에 닿는다.
#   ⚠️ template-ci는 이 고장을 원리적으로 못 잡는다 — 매트릭스가 양 아치를 각각 **네이티브** 러너에서
#   빌드하기 때문이다(QEMU 없음). 이 줄이 지키는 것은 앱이 실제로 빌드되는 venue이지 이 레포의 CI가 아니다.
#   cf. api·fullstack·worker도 같은 이유로 BUILDPLATFORM 고정이다(거긴 크로스컴파일이 덧붙는다).
FROM --platform=$BUILDPLATFORM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY . .
# 품질 게이트는 CI 잡이 아니라 이미지 빌드 안에 둔다(ADR-0001) — 타입 에러 = 빌드 실패.
RUN bun run typecheck
RUN bun run build

# static-web-server(SWS) :2 = scratch 기반 기본 이미지. ENTRYPOINT는 sws 바이너리.
# homelab 차트가 args(--port/--root /public/--page-fallback/--health) 주입. pod securityContext가 nonroot 강제.
FROM ghcr.io/static-web-server/static-web-server:2@sha256:2c1a7c3e0feaea5859307403b74e1c575f3ec1499094fc077344173d11abaae2
COPY --from=build /app/web/dist /public
