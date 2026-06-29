# {{APP}}

homelab 앱 (아키타입: **{{ARCHETYPE}}**) — `homelab-app-template`으로 스캐폴드됨.

## 개발
```bash
bun install
bun run dev      # (있는 경우) 로컬 개발 서버
bun run build    # 프로덕션 빌드
bun run typecheck
```

## 배포
1. `main`에 push → GitHub Actions가 GHCR에 arm64 이미지 빌드·push
2. owner가 homelab에서 `create-app` 디스패치 → 첫 배포 🚀
3. 이후 main 머지마다 homelab GHCR 폴링이 자동 배포(autoDeploy 시)

## 계약
- `.app-config.yml` = 배포 계약(`kind`/`resources`/`route` 등)
- 런타임: arm64 distroless non-root, http `:8080`
- 비밀 값은 코드에 두지 말 것 — `.app-config.yml`엔 이름만, 값은 SealedSecret로 봉인
