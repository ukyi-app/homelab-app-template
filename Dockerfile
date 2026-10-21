# 앱 이미지 계약(homelab 공유 차트와 app-build가 기대하는 것):
# - amd64 단일 빌드. app-build가 --platform linux/amd64로 부른다. 아키텍처별 파일을 받아야 하면
#   ARG TARGETARCH를 기본값 없이 선언한다. 기본값이 있으면 그것이 플랫폼 인자를 이긴다.
# - test 단계가 있어야 한다. app-build가 --target test로 시험을 돌린다.
# - 비root uid 65532(공유 차트의 runAsUser와 같다). 루트 파일시스템은 읽기 전용이고 쓰기는 /tmp만 된다.
# 기반 이미지는 digest로 고정하고 Renovate가 올린다.
FROM oven/bun:1.4.3-slim@sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM deps AS test
RUN bun install --frozen-lockfile
COPY . .
RUN bun test

FROM oven/bun:1.4.3-distroless@sha256:1aaa515018b0b37d95dbdebd55d1b7f37ad258a6289ba63e4bc3b9c9e3038697
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
USER 65532:65532
ENV PORT=8080
EXPOSE 8080
CMD ["src/server.ts"]
