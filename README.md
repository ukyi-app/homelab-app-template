# 앱 템플릿

homelab에 배포하는 앱 저장소의 첫 내용이다. 새 앱은 `homelab app new <앱>`이 이 템플릿으로 만든다(CLI가 생기기 전에는 `gh repo create ukyi-app/<앱> --public --template ukyi-app/homelab-app-template`).
앱 이름 = 저장소 이름 = 이미지 이름(`ghcr.io/ukyi-app/<앱>`)이고, 53자 이하 DNS 라벨이다. 저장소는 public이어야 한다.

## 앱 계약

- **시험:** Dockerfile의 `test` 단계. CI(homelab 공통 `app-build`)가 `--target test`로 돌린다. 언어를 바꿔도 이 단계 이름은 둔다.
- **이미지:** amd64 단일 빌드, 비root uid 65532. 루트 파일시스템은 읽기 전용이고 쓰기는 `/tmp`만 된다.
- **포트·상태:** env `PORT`로 받은 포트에서 듣는다(1024 이상). `GET /healthz`가 준비되면 200을 돌려준다(기본 readiness probe).
- **첫 접속 재시도:** 시작하자마자 같은 클러스터 안 상대(DB·Valkey 등)에 붙는 코드는 첫 접속 실패를 유한하게 재시도하고, 끝내 실패하면 마지막 오류를 남기고 종료한다. 마이그레이션도 같다. 아래 [첫 접속 재시도](#첫-접속-재시도)를 따른다.
- **배포:** main에 병합하면 이미지를 GHCR에 올리고, homelab에 등록된 앱이면 배포 PR이 자동으로 열리고 병합된다. 배포 설정은 이 저장소가 아니라 homelab의 `apps/<앱>/`에 있다. 첫 등록은 사람 PR이다(`homelab app add <앱>`).
- **CODEOWNERS·main 보호:** main은 PR과 code owner 리뷰로만 바뀐다. `.github/CODEOWNERS`는 `* @ukkiee` 한 줄만 둔다.
- **공개 내용:** tailnet 이름(`*.ts.net`)과 Tailscale 주소를 코드·로그·이미지에 두지 않는다(CI가 막는다). 시크릿 값은 저장소·로그·이미지에 두지 않는다.

## 로컬 개발

비밀은 파일(`.env` 등)로 만들지 않고 Infisical에서 환경변수로만 받는다. 개발용 값은 Infisical 프로젝트 `homelab-dev`에 있고 운영 값은 로컬에 오지 않는다.

Bun은 `.bun-version`(Dockerfile 기반 이미지와 같은 버전)을 쓴다. `bun.lock`은 lockfile v2라 Bun 1.4.0 미만은 읽지 못하고 의존성을 다시 풀어 버린다. `bun --version`이 `.bun-version`과 같은지 먼저 본다(mise·setup-bun은 이 파일을 읽는다).

```bash
infisical init                                           # 처음 한 번, 프로젝트 homelab-dev 선택(.infisical.json, 비밀 아님)
bun install
infisical run --env=dev --path=/apps/<앱> -- bun run dev
bun test
infisical run --env=dev --path=/apps/<앱> -- docker compose up --build   # 이미지로 실행. 127.0.0.1:8080
```

compose로 실행할 때 비밀은 `compose.yaml`의 `environment`에 이름만(값 없이) 적어야 컨테이너에 들어간다. `infisical run`은 compose 명령의 환경에만 값을 넣는다.

## 마이그레이션

DB를 쓰면 homelab `apps/<앱>/values.yaml`에 명령을 적는다. 배포(Argo CD Sync)마다 hook Job으로 먼저 돈다.

```yaml
migration:
  command: ["bun", "src/migrate.ts"]
```

- 멱등이어야 한다(매 Sync마다 다시 돈다).
- 이전 버전과 호환되게 나눈다(expand/contract). 새 컬럼을 더하는 배포와 옛 컬럼을 지우는 배포를 따로 한다.
- 앱은 시작할 때 스키마 버전만 확인하고 직접 마이그레이션하지 않는다.

## 첫 접속 재시도

새 파드는 시작 직후 잠깐 같은 클러스터 안 상대(DB·Valkey 등)에 접속이 거부된다(`Connection refused`). 상대 쪽 NetworkPolicy가 새 파드 IP를 아직 허용하지 않아서다(k3s kube-router, 실측 약 0.25초, 길면 수 초). 로컬 compose에는 이 지연이 없어 운영에서 처음 드러난다.

시작하자마자 상대에 붙는 코드(시작 때 스키마 버전 확인, 마이그레이션, worker의 첫 접속 등)는 다음을 지킨다.

- **유한 재시도:** 접속 단계 실패(거부·타임아웃)면 지수 backoff로 다시 시도하고 총 30초 안팎에서 멈춘다. 예: 0.25초에서 시작해 두 배씩, 한 번 대기는 최대 5초. 시도마다 접속 타임아웃을 둬야 총 상한이 지켜진다. 클라이언트 라이브러리의 자동 재연결에 맡긴다면 시도 수나 총 시간 상한이 있는지 확인한다.
- **실패는 드러나게:** 상한에 닿으면 마지막 오류를 로그에 남기고 0이 아닌 코드로 종료한다. 무한 대기나, 오류를 삼키고 접속 없이 계속 도는 것은 안 된다. 그래야 앱은 재시작 횟수로, 마이그레이션은 Sync 실패로 보인다.
- **마이그레이션도 스크립트 안에서 재시도한다:** hook Job의 재시도(`backoffLimit`)에 맡기지 않는다. Job 재시도는 새 파드를 만들어 같은 거부 창에 다시 걸린다.
- **로그에 시크릿을 쓰지 않는다:** `DATABASE_URL`·`VALKEY_URL`에는 비밀번호가 들어 있다. 로그에는 상대 호스트·포트, 시도 횟수, 오류 코드·메시지만 쓰고 URL이나 env 값은 쓰지 않는다. 드라이버 오류 메시지가 접속 문자열을 담지 않는지도 본다.

## 의존성 갱신

Renovate가 PR을 연다(자동 병합 없음). `.github/workflows/build.yaml`의 `app-build-vX.Y.Z` 태그도 Renovate가 올린다. 태그 대신 SHA로 바꾸지 않는다(파일 주석).
