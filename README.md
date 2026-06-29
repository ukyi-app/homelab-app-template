# homelab 앱 템플릿 (Bun + Hono + React)

대화형 스캐폴더로 즉시 배포 가능한 homelab 앱을 생성한다.

## 시작
1. 이 템플릿으로 레포 생성 (레포 이름 = 앱 이름, 소문자/숫자/하이픈, 2..40자)
2. clone 후:
   ```bash
   bun install
   bun run scaffold
   ```
3. 아키타입 선택 → 코드·`.app-config.yml` 자동 생성, 스캐폴더 자가삭제, `bun.lock` 재생성
   - 🌐 **Full-stack** (Hono + React, 한 컨테이너)
   - 🔌 **API** (Hono only)
   - 📄 **Static site** (React SPA → static-web-server)
   - ⚙️ **Worker** (백그라운드)
4. `git add -A && git commit && git push` (재생성된 lock 포함)
5. owner가 homelab에서 `create-app` 디스패치 → 첫 배포 🚀

## 런타임 계약
- http `:8080` (web/site), metrics `:9090` (web · opt-in)
- web: `/healthz`(liveness)·`/readyz`(readiness)
- site: static-web-server `/health`
- arm64 distroless non-root

## 비밀 값
코드에 절대 넣지 않는다. `.app-config.yml`엔 이름만 선언, 값은 SealedSecret로 봉인한다.

> 비대화형(CI/스크립트): `bun run scaffold --archetype <fullstack|api|site|worker> --name <app> [--public] [--metrics] [--no-autodeploy] --yes`
