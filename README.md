# homelab 앱 템플릿

## 시작
1. 이 템플릿으로 레포 생성 (레포 이름 = 앱 이름, 소문자/숫자/하이픈)
2. `.homelab.yaml` 수정 (kind/resources/route/db/env/secrets)
3. `src/` + `Dockerfile` 구현 — 계약: `:8080`(http, `/healthz`,`/readyz`), `:9090`(`/metrics`), `migrate` 커맨드(db 사용 시)
4. main에 push → 자동으로 homelab에 **온보딩 PR** 생성 → 머지하면 첫 배포 🚀
5. 이후 main 머지마다 자동 배포 (약 4–7분)

## 수동 승인 게이트 (선택)
`.homelab.yaml`의 `deploy.autoDeploy: false` + 이 레포 Settings → Environments → `production`에
required reviewer 등록 → 머지 후 Actions에서 승인해야 배포된다.

## 비밀 값
앱 레포에는 절대 넣지 않는다. `.homelab.yaml`의 `secrets:`에 이름만 선언하면 온보딩 PR이
homelab 쪽 SOPS 암호화 파일 작성 절차를 체크리스트로 안내한다.
