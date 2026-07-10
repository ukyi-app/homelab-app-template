# template-hardening — 리뷰 확정 발견 사항 (intake 입력 자료)

2026-07-10 멀티에이전트 리뷰 결과. 24건 발굴 → 건별 반박 검증(사실관계) +
실용성 판정(솔로 홈랩 ROI)을 거쳐 13건 확정(중복 1건 병합). 탈락 10건은 말미에
사유와 함께 기록. 각 항목은 검증 에이전트가 실제 코드/컨테이너로 확인한 것이다.

## 확정 findings

### F1. [critical] api/fullstack 서버 SIGTERM 미처리 — distroless PID 1에서 롤아웃마다 30초 행
- 파일: `scaffold/archetypes/api/src/index.ts:28`, `scaffold/archetypes/fullstack/src/index.ts:18`
- distroless에서 bun 프로세스는 PID 1. 커널은 PID 1에 핸들러 없는 시그널의 기본
  처리(terminate)를 적용하지 않아 SIGTERM이 무시된다. 컨테이너 재현: 핸들러 없으면
  `docker stop -t 10`이 10.4s(SIGKILL), 핸들러 있으면 0.16s 정상 종료. 차트 기본
  terminationGracePeriodSeconds=30 → ArgoCD 싱크·롤링 업데이트·노드 드레인마다 파드당 30초 행.
- 권고: 양쪽 index.ts에서 `Bun.serve()` 핸들을 변수로 잡고 SIGTERM/SIGINT에
  메인+메트릭 서버 stop 후 `process.exit(0)` 등록.

### F2. [high] pg Pool `error` 리스너 부재 — 유휴 커넥션 오류 시 파드 크래시, '정적 liveness' 설계 무력화
- 파일: `scaffold/archetypes/api/src/db.ts:12`
- node-pg는 유휴 커넥션이 끊기면(PgBouncer 재시작, cnpg 페일오버 등) 풀 `error`
  이벤트를 emit — 리스너 없으면 프로세스 즉사(pg 공식 문서 명시). index.ts:10 주석의
  "liveness — 정적. DB 일시장애로 파드가 죽지 않게" 의도를 정면 위반.
- 권고: `createPool()`에서 `pool.on('error', err => console.error('idle pg client error', err.message))` 등록.

### F3. [high] 배포 전 typecheck/test 게이트 전무 — 타입 에러가 클러스터까지 직행
- 파일: `scaffold/common/.github/workflows/release.yaml:12`
- homelab `reusable-app-build.yaml`은 docker build만 수행. `bun build --compile`은
  타입 stripping, `vite build`는 typecheck 미수행. 전 아키타입에 `typecheck` 스크립트가
  있지만 CI 어디서도 실행 안 됨 → GHCR push → autoDeploy로 그대로 배포.
- 권고: release.yaml build 앞 preflight 잡(`bun install && bun run typecheck`, 테스트
  존재 시 `bun test`). SSOT를 앱 레포에 두지 않으려면 Dockerfile RUN보다 preflight 잡 권장.

### F4. [high] 스캐폴드된 앱은 Renovate 스코프 밖 — base 이미지·의존성 영구 정체 (보안 드리프트)
- 파일: `renovate.json:1`
- renovate.json이 템플릿 루트에만 있고 `scaffold/common/`에 없음 + homelab
  `renovate.yaml`의 `RENOVATE_REPOSITORIES`가 `homelab,homelab-app-template` 고정
  (autodiscover 금지) → 생성된 앱 레포는 어떤 갱신도 못 받음. base 이미지 CVE 축적.
- 권고: `scaffold/common/renovate.json` 추가(config:recommended + pinDigests) +
  create-app 온보딩 시 RENOVATE_REPOSITORIES에 새 레포 배선(또는 allowlist autodiscover).

### F5. [medium] template-ci가 이미지를 build만 하고 run하지 않음 — 런타임 파손 미감지
- 파일: `.github/workflows/template-ci.yaml:34`
- "빌드는 통과하나 crash-loop" 부류를 CI가 못 잡음. 실측: 빌더 `oven/bun:1.3.14`는
  Debian 13(glibc 2.41), 런타임 `distroless/base-debian12`는 glibc 2.36 — 현재는
  낮은 baseline으로 링크돼 동작함을 확인했으나 bun baseline 상승 시 조용히 파손.
- 권고: 아키타입별 스모크 스텝 — web/api는 `docker run -d -p 8080` 후 `/healthz`·`/readyz`
  curl 200(api는 DB 미설정 시 readyz 정적 통과라 부가 인프라 불요), worker는 'worker started'
  로그 grep, site는 SWS args로 run 후 `/health`.

### F6. [medium] fullstack(기본 아키타입) `dev` 스크립트 부재 — README `bun run dev` 안내와 불일치
- 파일: `scaffold/archetypes/fullstack/package.partial.json:3`, `scaffold/common/README.app.md:8`
- fullstack에는 `dev:web`/`dev:server`만 존재(2-프로세스, vite proxy → :8080), 이 흐름은
  미문서화. 기본 추천 아키타입에서 README대로 치면 'Script not found'.
- 권고: 합쳐진 `dev` 스크립트 추가(병렬 실행) 또는 README 아키타입별 분기 + 2-프로세스 흐름 문서화.

### F7. [medium] .env.example 부재 + secret:seal 흐름 미문서화
- 파일: `scaffold/common/README.app.md:21` (.gitignore:8은 `!.env.example` 화이트리스트만 존재)
- seal-secret.mts는 .env UPPER_SNAKE 키가 SSOT인데, .env 작성법·`bun run secret:seal`
  실행법·kubeseal 필요성·산출물 커밋 흐름이 어디에도 없음.
- 권고: `scaffold/common/.env.example`(키 명명 규약 + DATABASE_URL 접미사 규약 주석) 추가,
  README.app.md에 '비밀 값' 섹션 신설(3줄 흐름: .env 작성 → secret:seal → sealed.yaml 커밋).

### F8. [medium] worker 종료가 Bun.sleep 주기에 묶임 + 작업 본문 예외 격리 없음
- 파일: `scaffold/archetypes/worker/src/index.ts:9`
- SIGTERM이 sleep 중 도착하면 잔여 시간 대기(컨테이너 재현: 약 4s 지연). 주기를 30~60s로
  늘리면 grace 30s 초과 → SIGKILL. 루프 본문 try/catch 부재 → 실작업 throw 시
  자체 백오프 없이 CrashLoopBackOff 직행.
- 권고: abort 가능한 sleep(AbortController; bun 미지원 시 Promise.race + 타이머 취소) +
  SIGTERM에서 abort. 루프 본문 try/catch로 일시 오류 로깅·백오프.

### F9. [medium] scaffold `--name`이 배포 식별자(레포명)와 분리 — repo==app 불변식과 모순, 온보딩 하드 리젝 가능
- 파일: `scaffold/scaffold.ts:57` (+ `scaffold.ts:101`의 secret:seal 스크립트)
- homelab은 레포명==앱 이름 강제(`create-app.ts:40` 불일치 시 실패,
  `reusable-app-build.yaml`은 repository.name으로만 빌드). scaffold의 `--name`은
  package.json/README에만 쓰여 배포에 미반영 — 이름이 다르면 문서가 거짓이 됨.
  secret:seal이 `--app` 미전달 → SealedSecret 이름이 cwd basename으로 결정,
  다른 이름으로 clone 시 create-app.ts:145의 `${app}-secrets` 검사에서 리젝.
- 권고: `--name` 자유 입력 제거(레포명 표시 전용) 또는 name≠basename 시 명시 경고.
  secret:seal에 `--app`(package.json.name) 명시해 cwd 의존 제거.

### F10. [low] 비대화형에서 `--metrics`/`--public`이 비호환 아키타입에서 무경고 드롭
- 파일: `scaffold/scaffold.ts:46` (반영 조건: 85행 route, 87행 metrics)
- `--archetype worker --public`, `--archetype site --metrics` 등에서 플래그가 조용히
  무시됨 — 스크립트 스스로 표방하는 fail-closed 규약(16행 주석)과 모순.
  대화형 경로(59-61행)는 이미 올바르게 게이팅됨.
- 권고: 비호환 조합에 stderr 경고(가볍게) 또는 exit 2.

### F11. [low] README.app.md 런타임 문구가 worker(`http :8080` 거짓)·site(`distroless` 거짓)에서 사실과 다름
- 파일: `scaffold/common/README.app.md:20`
- 공용 한 줄 "arm64 distroless non-root, http :8080"이 4개 아키타입에 일괄 적용.
  worker는 HTTP 비서빙(EXPOSE 없음), site는 SWS scratch 이미지.
- 권고: scaffold.ts가 이미 replaceAll 후처리하므로 아키타입별 런타임 한 줄 조건부 치환.

### F12. [low] template-ci 액션이 이동 태그(@v4/@v2) 참조 — homelab SHA 핀 규율과 불일치
- 파일: `.github/workflows/template-ci.yaml:20,21,84,85`
- homelab reusable-app-build.yaml은 전부 커밋 SHA 핀. 이 워크플로는 `pull_request: {}`
  트리거라 포크 PR에서도 실행(시크릿·write 권한은 없어 폭발 반경은 컴퓨트 한정).
- 권고: SHA 핀(+버전 주석), Renovate가 SHA 갱신.

### F13. [low] bun 1.3.14가 6곳 하드코딩(Dockerfile 4 + template-ci 2) — SSOT 없음 / 어떤 아키타입도 테스트 셋업 없음
- 파일: `scaffold/archetypes/*/Dockerfile:2`, `.github/workflows/template-ci.yaml:23,87`,
  `scaffold/archetypes/*/package.partial.json`
- (a) 다음 bun 범프 때 한 곳 누락 시 scaffold lock-재생성 bun과 frozen-lockfile 빌드 bun이
  어긋나 조용히 파손 가능. (b) test 스크립트·예제 테스트 전무 — F3 게이트와 맞물려 회귀 방어선 0.
- 권고: (a) Renovate group으로 동시 범프 강제 또는 CI grep 가드. (b) `"test": "bun test"` +
  아키타입별 예제 테스트 1개(healthz 라우트 스모크, api는 runtimeUrl discover 단위 테스트).

## 검토 후 탈락(10건) — 재발굴 방지용 기록

- 롤백이 in-place 수정된 package.json 미복원(사실이나, 일회성 스크립트 + git 내 실행이라
  `git checkout .` 복구 가능 — 실용성 탈락. 주석 "재시도 가능" 문구 수정만 고려).
- cpSync~bun install 사이 크래시 창에서 롤백 미실행·가드가 재실행 차단(동일 사유 탈락).
- 비대화형 basename 기본값이 유효 GitHub 레포명 거부(에러 메시지가 이미 충분히 명시적).
- lockfile 정합성 미검증(트리거 조건이 이 환경에 부재).
- 베이스 이미지 floating 태그(이미 Renovate pinDigests가 처리하는 영역).
- baked sealed-secrets cert 회전 위험(컨트롤러가 구 개인키를 삭제하지 않는 한 복호 지속 성공).
- secret:seal cert 신선도 preflight 부재(전제 사실 어긋남 — 동봉할 원본 스크립트 부재).
- raw.githubusercontent 스키마 fetch가 private 레포에서 파손(레포가 PUBLIC임을 확인 — 반박됨).
- `!.env.example` dead 규칙 주장(homelab에선 tools/env-example.mts가 생성하는 파생 산출물 — 반박됨.
  단, 템플릿에 example 부재 자체는 F7로 확정).
- Dockerfile·tsconfig·vite 설정의 영구 fork 드리프트(드리프트 표면이 작고 빌드 로직은 이미
  reusable-app-build.yaml @main 참조로 SSOT — 과한 세리머니 판정).
