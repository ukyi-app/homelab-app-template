# homelab 앱 템플릿

## 시작
1. 이 템플릿으로 레포 생성 (레포 이름 = 앱 이름, 소문자/숫자/하이픈)
2. 만들 앱 종류에 맞춰 scaffold 실행
3. `.app-config.yml` 수정 (kind/resources/route)
4. main에 push → 이미지 빌드·GHCR push (자동 배포 아님). 첫 온보딩은 **owner가 homelab에서 실행** → 생성 PR 머지 = 첫 배포
5. 이후 main 머지마다 자동 배포 (homelab GHCR 폴링이 감지 → autoDeploy면 자동 PR·머지)

```sh
pnpm scaffold --kind service
pnpm scaffold --kind static
pnpm scaffold --kind worker
pnpm install
```

`scaffold`는 kind에 맞는 `Dockerfile`과 앱 소스만 생성한다. 이미 같은 파일이 있으면 중단하며,
덮어쓰려면 `--force`를 붙인다.

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
`encryptedData` 키를 검증·배선한다. 키 이름과 값 형태는 제한하지 않으며 값은 출력하지 않는다.

## kind별 런타임 계약

| kind | 앱이 준비할 것 |
|---|---|
| `service` | `:8080`에서 HTTP 요청을 받고 `GET /health`가 200을 반환해야 한다. `/metrics`는 기본 불필요하며, `metrics.enabled: true`일 때만 `:9090/metrics`를 구현한다. |
| `static` | Vite `dist` 산출물을 이미지의 `/public`에 둔다. 차트가 static-web-server로 서빙하고 `/health`와 SPA fallback을 제공한다. `.app-config.yml`에는 `kind: static`만 쓰며 `static.server`는 쓰지 않는다. |
| `worker` | HTTP/Route/Probe 기본값이 없다. 장기 실행 프로세스만 준비한다. |
