# homelab 앱 템플릿

## 시작
1. 이 템플릿으로 레포 생성 (레포 이름 = 앱 이름, 소문자/숫자/하이픈)
2. `.homelab.yaml` 수정 (kind/resources/route/db/env/secrets)
3. `src/` + `Dockerfile` 구현 — 계약: `:8080`(http, `/healthz`,`/readyz`), `:9090`(`/metrics`), `migrate` 커맨드(db 사용 시)
4. main에 push → 이미지 빌드·GHCR push (자동 배포 아님). 첫 온보딩은 **owner가 homelab에서 실행** → 생성 PR 머지 = 첫 배포 🚀
5. 이후 main 머지마다 자동 배포 (homelab GHCR 폴링이 감지 → autoDeploy면 자동 PR·머지)

## 수동 승인 게이트 (선택)
`.homelab.yaml`의 `deploy.autoDeploy: false` + 이 레포 Settings → Environments → `production`에
required reviewer 등록 → 머지 후 Actions에서 승인해야 배포된다.

## 비밀 값
앱 레포에는 절대 넣지 않는다. `.homelab.yaml`의 `secrets:`에 이름만 선언하면 온보딩 PR이
homelab 쪽 SOPS 암호화 파일 작성 절차를 체크리스트로 안내한다.
