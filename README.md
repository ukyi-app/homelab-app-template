# homelab 앱 템플릿

## 시작
1. 이 템플릿으로 레포 생성 (레포 이름 = 앱 이름, 소문자/숫자/하이픈)
2. `.app-config.yml` 수정 (kind/resources/route)
3. `src/` + `Dockerfile` 구현 — 계약: `:8080`(http, `/healthz`,`/readyz`), `:9090`(`/metrics`); DB 사용 시 앱이 부팅 시 self-migrate(expand/contract+멱등, 별도 migrate Job 없음)
4. main에 push → 이미지 빌드·GHCR push (자동 배포 아님). 첫 온보딩은 **owner가 homelab에서 실행** → 생성 PR 머지 = 첫 배포 🚀
5. 이후 main 머지마다 자동 배포 (homelab GHCR 폴링이 감지 → autoDeploy면 자동 PR·머지)

## 수동 승인 게이트 (선택)
`.app-config.yml`의 `deploy.autoDeploy: false`로 두면, homelab GHCR 폴링이 새 이미지를
자동 머지하지 않고 **승인 PR**로 올린다 — owner가 homelab에서 리뷰·머지해야 배포된다.

## 비밀 값
앱 레포 코드에는 절대 넣지 않는다. `.env`에 UPPER_SNAKE 키로 값을 두고 `pnpm secret:seal`을 실행한다.

```sh
pnpm install
printf 'ENV_TEST=hello\n' > .env
pnpm secret:seal
```

`secret:seal`은 `.env`의 UPPER_SNAKE 키 전체를 봉인해서 `deploy/<앱>-secrets.sealed.yaml`을 만든다.
`.env`에서 제거한 키는 다음 봉인본에서도 제거된다. owner의 create-app/update-secrets가 이 봉인 파일의
`encryptedData` 키를 검증·배선한다. `DATABASE_ADMIN_URL`은 앱 런타임 봉인 대상이 아니다.
