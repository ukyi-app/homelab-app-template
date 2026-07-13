---
feature: template-hardening
invariant-class: feature
entry-track: feature
review-track: standard
pipeline-stage: done
issue-tracker: local
prd-published: true
issues: [I-1, I-2, I-3, I-4, I-5, I-6, I-7, I-8]
skeleton-issue: []   # standard 트랙 — structure gate 미실행, 배리어 비활성(P-4 결정)
---

# template-hardening — 스캐폴드 산출물 런타임·수명주기 강화

## Problem Statement

템플릿은 "즉시 배포 가능한 앱"을 약속하지만, 2026-07-10 멀티에이전트 리뷰
(`docs/reviews/template-hardening/review-findings.md`, 13건 확정)가 보여주듯
생성된 앱은 세 방향에서 그 약속을 어긴다.

1. **런타임 계약 위반** — web 계열 앱은 SIGTERM 핸들러가 없어 distroless PID 1에서
   시그널이 무시되고, 모든 롤아웃·노드 드레인마다 파드가 유예시간 30초를 통째로
   매달렸다 SIGKILL된다(컨테이너 재현: 핸들러 유무에 따라 10.4s vs 0.16s).
   api 앱은 pg 풀에 error 리스너가 없어 유휴 커넥션 순단(풀러 재시작, 페일오버)이
   "DB 일시장애로 파드가 죽지 않게"라는 자체 설계 의도를 뒤집고 프로세스를 즉사시킨다.
   worker는 SIGTERM 수신이 sleep 주기에 묶이고 작업 예외 격리가 없다.
2. **수명주기 공백** — 배포 경로 어디에도 타입 검사·테스트 게이트가 없어 깨진 코드가
   GHCR → autoDeploy로 직행하고, 생성된 앱 레포는 Renovate 스코프 밖이라 base 이미지
   CVE·의존성이 영구 정체되며, template-ci는 이미지를 build만 하고 기동 검증이 없어
   "빌드는 통과, 기동은 실패" 회귀(빌더/런타임 glibc 갭 등)를 감지하지 못한다.
3. **DX·문서 부정합** — 기본 아키타입(fullstack)에 README가 안내하는 `bun run dev`가
   없고, 봉인 흐름(.env → SealedSecret)이 미문서화(.env.example 부재)이며, README의
   런타임 문구가 worker(`http :8080` 거짓)·site(`distroless` 거짓)에서 사실과 다르고,
   스캐폴드의 앱 이름 입력이 배포 식별자(레포명)와 분리되어 봉인 산출물 이름이
   create-app 온보딩 검사에서 리젝될 수 있다.

## Solution

확정 13건을 하나의 배치로 통합해 세 축을 강화한다.

1. **런타임 계약 완성** — web 계열에 SIGTERM/SIGINT 정상 종료(메인+metrics 서버 정리
   후 종료), api 풀에 error 리스너(순단은 크래시가 아니라 다음 readiness 503으로
   표출), worker에 중단 가능한 sleep + 작업 본문 예외 격리.
2. **게이트 계층 구축** — 이미지 빌드 자체를 게이트로(typecheck 전 아키타입 + 테스트
   동봉 아키타입은 bun test, ADR-0001), 앱 코드는 테스트 가능한 구조로 출발
   (app export + 엔트리 가드), template-ci에 4개 아키타입 스모크 런·bun 버전 정합
   grep 가드·액션 SHA 핀 추가, 생성 앱에 Renovate 설정 동봉.
3. **DX·문서 정합** — fullstack 통합 dev 스크립트, .env.example + 봉인 흐름 문서,
   README 런타임 문구의 아키타입별 치환, 앱 이름의 origin 유도 + 불일치 경고 +
   봉인 스크립트의 앱 이름 베이크(ADR-0002), 비호환 플래그 경고, 롤백 주석 정직화.

## User Stories

1. As 앱 운영자, I want web 앱이 SIGTERM에 즉시 정상 종료하기를, so that 롤아웃·
   ArgoCD 싱크·노드 드레인이 파드당 30초씩 매달리지 않는다.
2. As 앱 운영자, I want 종료 시 메인 서버와 metrics 서버가 함께 정리되기를, so that
   어떤 리스너도 종료를 붙잡지 않는다.
3. As 앱 운영자, I want DB 유휴 커넥션 순단이 프로세스 크래시가 아니라 readiness
   503으로 표출되기를, so that 풀러 재시작·페일오버 중에도 liveness가 파드를 유지하고
   복구가 자동으로 이뤄진다.
4. As 앱 운영자, I want worker가 sleep 도중 SIGTERM을 받아도 즉시 깨어나 종료하기를,
   so that 작업 주기를 늘려도 유예시간을 넘겨 SIGKILL당하지 않는다.
5. As 앱 개발자, I want worker 작업 본문의 일시 오류가 로깅·백오프로 격리되기를,
   so that 예외 한 번이 CrashLoopBackOff로 직행하지 않는다.
6. As 앱 개발자, I want 타입 에러가 있으면 이미지 빌드가 실패하기를, so that 깨진
   코드가 GHCR push·autoDeploy에 도달하지 못한다.
7. As 앱 개발자, I want 스캐폴드된 앱이 처음부터 테스트 가능한 구조이기를, so that
   서버를 기동하지 않고도 라우트 동작을 검증할 수 있다.
8. As 앱 개발자, I want 동봉된 스모크 테스트가 이미지 빌드에서 실행되기를, so that
   내가 6개월 뒤 코드를 고쳐도 회귀가 빌드 단계에서 잡힌다.
9. As homelab 운영자, I want 생성된 앱 레포에 Renovate 설정이 동봉되어 **등록 즉시
   동작할 준비**가 되어 있기를, so that homelab 쪽 레포 등록(추적되는 follow-up)
   하나만으로 base 이미지·의존성 보안 패치가 흐르기 시작한다.
10. As 템플릿 관리자, I want template-ci가 4개 아키타입 이미지를 실제로 기동해
    런타임 계약(응답·로그)을 검증하기를, so that 빌더/런타임 베이스 갭 같은
    "빌드는 통과, 기동은 실패" 회귀를 머지 전에 잡는다.
11. As 템플릿 관리자, I want bun 버전이 쓰이는 모든 지점의 정합이 CI에서 강제되기를,
    so that 부분 범프가 frozen-lockfile 빌드를 조용히 깨뜨리지 않는다.
12. As 템플릿 관리자, I want template-ci의 GitHub 액션이 커밋 SHA로 핀되기를,
    so that 이동 태그 탈취가 포크 PR 러너에서 임의 코드를 실행하지 못한다.
13. As 신규 앱 작성자, I want fullstack에서 `bun run dev` 한 번으로 서버와 웹이
    함께 뜨기를, so that README가 안내하는 대로 개발을 시작할 수 있다.
14. As 신규 앱 작성자, I want .env.example과 봉인 흐름 3단계 문서를, so that 어떤
    키를 .env에 넣고 어떻게 봉인해 배포하는지 스스로 알 수 있다.
15. As 신규 앱 작성자, I want README의 런타임 문구가 내 아키타입의 실제와 일치하기를,
    so that 잘못된 포트·이미지 가정으로 라우트나 프로브를 설정하지 않는다.
16. As 신규 앱 작성자, I want 스캐폴드가 앱 이름을 git origin에서 유도하고 불일치를
    경고하기를, so that 배포 식별자와 어긋난 이름이 조용히 박히지 않는다.
17. As 신규 앱 작성자, I want 봉인 산출물 이름이 실행 디렉토리가 아니라 앱 이름에서
    파생되기를, so that 클론 디렉토리명과 무관하게 create-app 온보딩 검사를 통과한다.
18. As CI/자동화 작성자, I want 비대화형 스캐폴드에서 비호환 플래그가 stderr 경고를
    남기기를, so that 의도한 옵션이 조용히 증발했음을 로그에서 알 수 있다.
19. As 템플릿 관리자, I want 스캐폴더의 실패 복구 주석이 실제 동작을 정직하게
    설명하기를, so that 실패 시 잘못된 복구 절차를 믿지 않는다.

## Implementation Decisions

- **게이트는 Dockerfile에 내장한다(ADR-0001).** 각 아키타입 빌드 스테이지의 build
  앞에 typecheck를, 테스트를 동봉하는 아키타입(api·fullstack)은 bun test를 추가한다.
  release 워크플로는 thin-caller로 유지하고 CI preflight 잡은 만들지 않는다.
- **테스트 가능한 구조: app 팩토리 + 엔트리 가드.** api·fullstack의 서버 모듈은
  Hono app을 export하고, 서버 기동(Bun.serve)은 `import.meta.main` 가드 안으로
  옮긴다 — import 부수효과 없이 `app.fetch`로 라우트를 검증할 수 있는 유일한
  신규 seam이다. api는 한 걸음 더 나가 **app 생성이 DB 풀을 주입받는 팩토리**다
  (기본값: env에서 자동 발견된 풀) — DB 실패 경로를 스텁 풀로 검증할 수 있게
  하는 P-1 결정. **error 리스너 등록은 풀 준비 함수 한 곳에만 있고, 팩토리가
  env에서 만든 풀이든 테스트가 주입한 풀이든 같은 준비 경로를 통과한다**(P-6
  결정 — 주입이 프로덕션 리스너 등록을 우회하지 못하게). worker·site는 테스트
  표면이 없어 테스트를 동봉하지 않는다.
- **graceful shutdown.** web 계열은 메인·metrics 서버 핸들을 잡아 SIGTERM/SIGINT에
  둘 다 stop 후 종료 코드 0으로 끝낸다(드레인 세리머니 없음 — 차트 preStop은
  범위 밖). worker는 중단 가능한 sleep(abort 신호로 즉시 기상)과 루프 본문
  try/catch(일시 오류 로깅·백오프, 치명 오류만 전파)를 갖춘다.
- **pg 풀 오류 격리.** 풀 준비 경로(생성·주입 공통, 위 P-6 결정)에서 error
  리스너를 등록해 유휴 커넥션 오류를 로깅만 하고 삼킨다 — 순단은 다음 readiness
  왕복에서 503/재연결로 자연 수렴한다("정적 liveness" 설계 의도 유지).
- **앱 이름 유도(ADR-0002).** 이름 기본값은 git origin URL에서 유도하고(없으면
  디렉토리명 fallback), 명시 입력이 유도값과 다르면 "배포 식별자가 아니다"라고
  stderr 경고한다(하드 실패 없음 — 최종 강제는 homelab create-app에 이미 존재).
  봉인 스크립트 호출에는 유도된 앱 이름을 `--app`으로 베이크해 실행 디렉토리
  의존을 제거한다.
- **비호환 플래그는 경고.** worker에 public/metrics, site에 metrics처럼 kind와
  무관한 플래그는 stderr 경고 후 무시한다. 알 수 없는 플래그는 기존대로 즉시
  실패(exit 2) — 오타와 의도는 다르게 다룬다.
- **스모크 런은 4개 아키타입 전부.** web/api는 컨테이너 기동 후 liveness·readiness
  경로 200 확인(api는 무DB 시 readiness 정적 통과라 부가 인프라 불요), worker는
  기동 로그 확인에 더해 **sleep 도중 SIGTERM을 보내 제한 시간 내 종료(수 초)·
  종료 코드 0·종료 로그를 단언**한다(중단 가능한 sleep의 직접 검증 — P-2 결정),
  site는 최소 인자(포트·루트·헬스)만 주입해 헬스 경로 확인 — 차트의 세부 인자
  재현은 하지 않는다.
- **bun 버전 정합 grep 가드.** template-ci에 "모든 아키타입 Dockerfile의 베이스
  태그 == CI의 setup-bun 버전" 검증 스텝을 추가한다(Renovate group 규칙 대신 —
  수동 범프 누락도 잡는 fail-closed 쪽 선택).
- **액션 SHA 핀.** template-ci의 서드파티 액션을 커밋 SHA(+버전 주석)로 핀한다.
- **Renovate 동봉.** 공통 스캐폴드 자산에 renovate 설정(config:recommended +
  pinDigests)을 추가해 모든 생성 앱이 상속하게 한다. homelab 쪽 레포 등록 배선은
  범위 밖(Out of Scope 참조).
- **fullstack 통합 dev.** concurrently를 devDependency로 추가해 서버·웹 개발
  프로세스를 한 명령으로 병렬 기동한다(접두어 로그, 동반 종료).
- **문서 정합.** 앱 README의 런타임 한 줄은 스캐폴더가 아키타입별 문구로 치환한다
  (worker: HTTP 비서빙, site: 정적 서버 — distroless 아님). 비밀 값 섹션을 신설해
  .env 작성 → 봉인 실행(kubeseal 필요) → 봉인 산출물 커밋 3단계를 명시하고,
  .env.example(UPPER_SNAKE 규약 + DATABASE_URL 접미사 규약 주석)을 동봉한다.
  개발 섹션은 fullstack의 2-프로세스 구조(API 프록시 포함)를 설명한다.
- **롤백 주석 정직화.** 스캐폴더의 "재시도 가능" 주석을 실제 동작("실패 시
  git checkout . 으로 복구")으로 정정한다 — 롤백 메커니즘 자체는 손대지 않는다.

## Testing Decisions

- **좋은 테스트의 기준**: 외부에서 관찰 가능한 행동만 검증한다 — HTTP 응답 코드,
  컨테이너 기동 로그, 프로세스 종료 시간·종료 코드, 생성 파일. 내부 함수 호출
  순서나 구현 세부는 검증하지 않는다.
- **이미지 경계(최상위 기존 seam)**: template-ci 스모크 런이 빌드된 이미지를 실제
  기동해 런타임 계약을 검증한다. SIGTERM 정상 종료는 컨테이너 stop 소요 시간이
  유예시간보다 훨씬 짧음(수 초 이내)으로 같은 경계에서 검증한다 — 리뷰 검증
  에이전트가 실측한 방법과 동일. Prior art: template-ci의 기존
  docker build(frozen-lockfile) 스텝과 아키타입 매트릭스.
- **HTTP 핸들러 seam(유일한 신규 seam)**: export된 app에 요청 객체를 직접 넣어
  (`app.fetch`) 서버 기동 없이 liveness·readiness·예제 API 라우트를 검증한다.
  api의 DB 복구는 **상태 있는 스텁 풀 하나 + 단일 app 인스턴스**로 같은 풀의
  전 시퀀스를 검증한다(P-1·P-6 결정): 풀이 `error` 이벤트를 emit → 프로세스
  생존 단언(error 리스너 계약) → query 거부 상태에서 readiness 503 → **같은
  풀**을 성공 상태로 전환 → readiness 200(회복 증명). 무DB(null 풀) 분기의
  readiness 200은 별도 케이스로 검증한다. 스텁 풀도 프로덕션과 동일한 풀 준비
  경로로 주입되어 리스너 등록을 우회하지 않는다. 임시 Postgres/PgBouncer를
  띄우는 이미지 레벨 DB 테스트는 하지 않는다(주입-풀 seam이 동일 전이를 커버).
- **순수 함수 seam**: api의 DB URL 자동 발견 로직(접미사 매칭, MIGRATE_/RO_ 제외,
  generic fallback)을 env 맵 입출력으로 단위 테스트한다 — provision-db env 계약의
  회귀 방어선.
- **CI 자기 검증**: 스캐폴더의 새 경고 동작(이름 불일치, 비호환 플래그)은
  template-ci의 기존 strict-parse 네거티브 패턴(prior art: scaffold-args 잡)을
  따라 stderr 출력 존재로 검증할 수 있다. fullstack의 dev 오케스트레이션은
  **존재 계약만 단언**한다(스캐폴드 산출물에 dev 스크립트와 concurrently
  devDependency가 있음 — 기존 계약-검증 스타일) — `bun run dev`를 실제 기동하는
  프로세스 seam은 두지 않는다(P-5 결정: CI 플레이크 위험이 가치를 초과).
- **테스트가 실행되는 곳**: 동봉 테스트는 Dockerfile 게이트(bun test)와 로컬
  `bun test`에서 돌고, 스모크 런·grep 가드·네거티브는 template-ci에서 돈다.

## Out of Scope

- **homelab 쪽 Renovate 배선** — 생성된 앱 레포를 Renovate 실행 대상 목록에
  추가하는 일(또는 allowlist autodiscover 전환)은 homelab 레포 변경이다.
  follow-up으로 추적한다(P-3 결정): 담당 = 오너, 위치 = homelab 레포 이슈(이
  배치의 done 단계에서 파일), 시점 = 다음 신규 앱 생성 전, 수용 기준 = Renovate
  런 로그에 해당 앱 레포 스캔이 나타남. 이 배치의 유저 스토리 9는 "등록 즉시
  동작할 준비"까지만 책임진다.
- **리뷰 탈락 10건** — 롤백 메커니즘 전면 수리, 봉인 cert 신선도 게이트, 베이스
  이미지 digest 수동 핀 등. 사유는 `docs/reviews/template-hardening/review-findings.md`
  말미에 기록되어 있다(재발굴 방지).
- **게이트의 reusable 워크플로 이관** — Dockerfile 게이트를 homelab
  reusable-app-build로 옮기는 것은 교차-레포 작업(ADR-0001의 미래 옵션).
- **worker·site 테스트 셋업** — 테스트할 외부 행동 표면이 없다(worker 루프 본문은
  TODO 자리, site는 정적 산출물).
- **차트 인자 전량 재현** — site 스모크 런은 최소 인자만 쓴다. 차트 인자 변경
  추적은 homelab 쪽 계약 테스트의 몫.
- **metrics 실측 지표 확장, 무중단 드레인(preStop) 튜닝** — 현행 계약 유지.

## Further Notes

- 발견 사항 전문·검증 사유: `docs/reviews/template-hardening/review-findings.md`.
  용어는 CONTEXT.md, 구조 결정은 ADR-0001(Dockerfile 게이트)·ADR-0002(앱 식별자)를
  따른다.
- 이슈 분해 힌트(intake 합의 + P-4 의존 순서): 응집도 기준 ~7개 수직 슬라이스 —
  graceful shutdown 일괄(웹+worker), pg 오류 격리, 테스트 구조(app 팩토리)+
  Dockerfile 게이트, template-ci 강화 일괄(스모크·SHA 핀·grep 가드), 스캐폴더
  강화(이름 유도·플래그 경고·주석 정정), Renovate 동봉, DX/문서 일괄(dev·
  .env.example·README 치환). **의존 엣지**: ① template-ci의 스모크 런(특히
  SIGTERM 종료 검증)은 런타임 종료 슬라이스(graceful shutdown) **이후**에만
  수용 가능, ② 동봉 테스트·Dockerfile `bun test` 게이트는 테스트 구조(app
  팩토리) 슬라이스에 의존, ③ 같은 서버 모듈을 만지는 슬라이스(shutdown, pg
  오류 격리, app 팩토리)는 병렬 편집 충돌을 피하도록 순서화한다(shutdown →
  app 팩토리 → pg 격리 권장). 문서-only 슬라이스는 의존 없음.
- CI가 임시 디렉토리에서 `--name ci-<archetype>`로 스캐폴드하는 기존 사용처는
  유지된다(경고는 나되 실패하지 않음 — ADR-0002).
- 스캐폴드된 앱은 Dockerfile·테스트를 포크해 가므로 이 배치의 개선은 신규 앱에만
  적용된다. 기존 앱 소급은 별도 판단(범위 밖).

## Review Decision Log

### Codex Plan Review — r1
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| P-1 | Open question: which seam tests database failover recovery? | high | Accept (Question 답변) | 주입-풀 seam이 동일 전이(생존/503/회복)를 커버하며 임시 Postgres 이미지 테스트는 솔로 CI에 인프라 과중 | api를 app 팩토리(주입 가능 DB 풀)로 확장, Testing Decisions에 3전이 스텁-풀 테스트 명시 |
| P-2 | Open question: which seam tests worker lifecycle behavior? | medium | Accept (Question 답변, 부분) | SIGTERM-during-sleep은 이미지 경계에서 저비용 직접 검증 가능; 치명/일시 분류·주입 픽스처는 TODO 자리 루프에 과설계 | 스모크 런에 worker SIGTERM 제한시간·종료코드·종료로그 단언 추가; 분류 체계는 도입 안 함 |
| P-3 | Renovate configuration cannot deliver the promised security updates | medium | Accept | 등록은 교차-레포 작업이라 이 배치 범위 밖이 맞고, 스토리가 결과를 과장하면 안 됨 | 유저 스토리 9를 "등록 즉시 동작할 준비"로 축소, follow-up을 담당·위치·시점·수용 기준과 함께 구체화(F-1) |
| P-4 | Walking-skeleton and dependency order are undefined | medium | Accept (부분) | 의존 엣지 부재는 실제 실행 위험(순서 역전·중복 편집); 단 스켈레톤 지정은 standard 트랙(structure gate 미실행, 배리어 비활성)이라 해당 없음 | 분해 힌트에 의존 엣지 3종 명시; 스켈레톤 미지정 사유 본 로그에 기록 |
| P-5 | Open question: which seam tests fullstack development orchestration? | low | Accept (Question 답변, 부분) | CI 백그라운드 프로세스+포트 대기 seam은 플레이크 위험이 DX 스크립트 가치를 초과; concurrently는 자체 검증된 도구 | template-ci에 dev 스크립트·concurrently devDep 존재 단언만 추가(프로세스 seam 기각) |

### Codex Plan Review — r2: needs-attention (escalated)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| P-6 | Database recovery transition is still untested (P-1 후속) | high | Accept | 사람이 수동 r3 승인(옵션 b) — 지적 타당: null-풀 교체는 회복 증명이 아니며 주입이 리스너 등록을 우회 가능 | 상태 있는 단일 스텁 풀 시퀀스(error→생존→503→같은 풀 회복→200) + 공유 풀-준비 경로를 Testing/Implementation Decisions에 명시, r3 실행 |

### Codex Plan Review — r3: clean — verdict approve, 0 findings, P-6 resolved (shared listener registration + stateful single-pool recovery sequence preserved as executable acceptance criteria)

### Codex Release Review — r1 (sha a63257d 기준 이전)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| R-1 | Non-authoritative `--name` still controls the deployment secret | high | Accept | 스캐폴더가 "이 값은 배포 식별자가 아니다"라고 경고해놓고 그 값을 `secret:seal --app`에 베이크 — origin `real-name` + `--name ci-api`면 `ci-api-secrets`가 나오는데 create-app은 `real-name-secrets`를 요구(하드 리젝) | 배포 이름(origin 유도) / 표시 이름(`--name`) 분리, 봉인엔 배포 이름만. 교차 케이스 실측(3df189b) |
| R-2 | I-8 cleanup is too late for history and too broad for user data | high | **Accept(절반) / Reject(절반)** | **데이터 손실 반쪽 수용**: `docs/` 통째 삭제가 사용자가 스캐폴드 前 넣어둔 파일을 무음 파괴. **히스토리 반쪽 기각**: GitHub 템플릿 복사는 이 레포 밖 동작이고 초기 커밋 재작성은 스캐폴더의 일이 아니다(강제 push 필요) | 전개 前 가드 — 최초 커밋 트리에 없는 파일이 SELF_DELETE 경로에 있으면 변경 전에 exit 2 |
| R-3 | Missing verification: template-ci never ran on GitHub Actions | high | Accept | AC가 "CI가 green이다"인데 로컬 대체 검증만 하고 공백을 문서화만 했다 | PR #14로 실제 러너 실행, 5개 잡 green, run URL·SHA를 증거에 기록 |
| R-4 | Worker failure handling reintroduces raw error-object logging | medium | Accept | 이 브랜치의 db.ts가 **바로 그 패턴이 DB 비밀번호를 평문 노출**함을 재현·문서화해놓고 worker엔 그대로 뒀다 | sanitize 로깅 + sentinel 회귀 실측 |

### Codex Release Review — r2 (사람이 수동 r3 승인)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| R-5 | R-2 guard exempts ignored user files from protection | high | Accept | 가드가 ignore된 untracked를 전부 "템플릿이 실은 것"으로 분류 — `docs/notes.local`·`docs/.env`가 무음 삭제됐다(r1 증거는 비-ignore 파일만 테스트해 우회를 놓침) | ignore 상태를 소유권의 대리물로 쓰지 않는다; basename 화이트리스트(.DS_Store/Thumbs.db)만 예외 (6a801be) |
| R-6 | R-4 sanitizer crashes on nullish thrown values | medium | Accept | 타입 단언 후 구조분해 → `throw null`이 catch 안에서 다시 throw해 프로세스 사망. **예외 격리용 try/catch가 오히려 죽이는** 상황 | 런타임 좁히기 (6a801be) |

### Codex Release Review — r3 (사람이 수동 r4 승인)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| R-7 | R-6 sanitizer can still throw while inspecting an error | medium | Accept | `code`/`stack`/`message` 읽기가 임의의 getter·Proxy trap을 호출 → catch 안에서 던져 사망 | 비-throw 포매터(필드별 try/catch + 상수 폴백). 같은 패턴이 db.ts에도 있어 함께 교정 (60e0ec9) |

### Codex Release Review — r4 (사람이 접근법 전환 승인)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| R-8 | Callable values bypass the non-expanding error sanitizer | medium | **Accept — 재설계** | 원시값 분기가 함수를 포함 → `String(e)`가 non-throwing `Symbol.toPrimitive`를 실행해 첨부 password 유출. **R-7 수정이 만든 회귀.** 사람이 "코드가 아니라 접근법이 틀렸다"고 판단(네 라운드 연속 같은 클래스) | 블록리스트 → **allowlist-only** 재설계: 강제 변환 훅이 코드에서 전부 사라짐 (5322d06) |

### Codex Release Review — r5 (사람이 수동 r6 승인)
| ID | Finding | Severity | Decision | Reason | Action |
|----|---------|----------|----------|--------|--------|
| R-9 | Allowlisted reads still execute callable accessors | medium | Accept | allowlist가 "어떤 값을 쓸지"만 제한하고 "어떻게 읽을지"는 제한하지 않았다 — `e[key]`는 여전히 남의 코드를 실행하고, **성공하는** getter의 반환값은 신뢰됐다. R-8 재설계가 만든 회귀(강제 변환 훅 → accessor 훅) | **descriptor-only**: own 데이터 서술자만 수용, accessor는 호출하지 않고 거절. 같은 클래스의 마지막 인스턴스(`/readyz`)도 교정 (12d8716) |

### Codex Release Review — r6: **BLOCKED → 사람이 잔여 리스크 waive (2026-07-13)**

**게이트 엔진이 형식적 판정을 내지 못했다.** r6는 여섯 번 시도했고(전체 브랜치 diff / focus 축소 /
base 축소 / timeout 3600s) 매번 `codexStatus: 1`로 중단됐다. 진단: `--selftest` 정상, 작은 레포에서
**같은 release 루브릭이 정상 완주**(codexStatus 0, 2건 발견) — 엔진·루브릭·인증 문제가 아니라 이
브랜치 리뷰에 특정된 장애다. `verdict: approve` / `findings: []`가 반환됐으나 이는 승인이 아니라
**리뷰 미수행**이며(하드 룰 2), 승인으로 취급하지 않았다.

**다만 중단 직전 summary에 실질 발견이 남았고, 그 지적은 옳다**:
> 살아있는 Proxy는 자신의 `getOwnPropertyDescriptor` trap을 실행해, 첨부된 password를 담은 own
> 데이터 서술자를 반환할 수 있다 — 현재 헬퍼는 그것을 수용해 내보낸다.

즉 "trap이 돌려주는 데이터는 앱이 스스로 빚은 것뿐"이라는 제 정리는 부정확했다. trap은
`client.password`를 **`message`인 척 합성**할 수 있다.

**사람의 결정: 이 잔여를 수용(waive)한다.** 근거:
- **JS의 구조적 한계다.** 임의의 값에서 **어떤 프로퍼티든 읽는 순간** Proxy trap이 돌 수 있다
  (`getOwnPropertyDescriptor`·`Reflect.ownKeys`·`Symbol.toStringTag` 전부 trap 대상). Proxy 여부를
  판별하는 방법은 JS에 없다. 완전 차단의 유일한 길은 **객체에서 아무것도 읽지 않고 타입만 로깅**하는
  것인데, 그러면 `message`·`code`가 사라져 이 작업이 지키려던 진단 가치(실 Postgres의 `57P01`/`28P01`
  원인 식별)가 소멸한다.
- **위협 모델이 다르다.** 재현된 실제 위협(R-4)은 pg가 **선의로** `client.password`를 진짜 Error에
  첨부한 **수동적 유출**이고, 그것은 완전히 닫혔다. 적대적 Proxy는 **공격자 코드가 이미 프로세스 안에서
  돌고 있어야** 성립하며, 그 층위에서는 공격자가 직접 password를 로깅하면 되므로 포매터가 방어할 수
  있는 경계가 아니다.
- 실재하지 않는 위협을 막으려 실재하는 운영 가치를 버리는 교환은 하지 않는다.

**기록**: F-6 follow-up으로 남긴다(게이트 엔진 장애 재현 시 재리뷰 + Proxy 잔여 재평가).

### 실행 중 발견된 전제 정정 (I-3, 2026-07-12)

Problem Statement의 "api 앱은 pg 풀에 error 리스너가 없어 유휴 커넥션 순단이 … 프로세스를
즉사시킨다"는 **현 런타임에서 재현되지 않는다**. 두 리뷰어가 독립적으로 PRE-FIX 이미지를 실
Postgres에 물려 `pg_terminate_backend`·DB 컨테이너 종료를 시도했으나 컨테이너는 생존했다
(restarts=0). pg는 pool `error`를 emit하지만(POST-FIX가 로깅으로 증명) Bun이 pg 소켓 콜백
경로의 throw를 무음으로 삼킨다. 회복(503→200)도 I-2의 try/catch로 이미 동작하고 있었다.

I-3의 실제 가치는 (a) **pg 계약 준수** — unhandled pool error가 던져지는 것이 pg의 문서화된
계약이고 Bun의 삼킴은 미명세 동작이라, Bun 베이스 범프가 즉사를 복원할 수 있다; (b) **관측성**
— pre-fix는 순단이 완전 침묵이었다. 이 근거로 I-3는 유효하며 되돌리지 않는다. 원 리뷰 findings
(F2)의 severity 판단은 과대평가였음을 기록한다.

## Follow-up Backlog
| ID | Item | Source | Issue |
|----|------|--------|-------|
| F-1 | ✅ **처리됨(2026-07-13)** — autodiscover + `requireConfig=required`로 전환해 '설정 파일의 존재 = opt-in'이 되게 했다(신규 앱은 템플릿이 설정을 동봉하므로 자동 편입, 비-앱 레포는 `disabled-no-config`로 자동 스킵 — dry-run 실측). PR: homelab#347, page#9, trip-mate-api#30. **남은 owner 수동 1건**: writer App(ukyi-homelab-writer) 설치 범위를 `selected` → 조직 전체(All repositories)로 확대 — 그 전까지는 기존 대상만 계속 돈다(fail-safe) | P-3 | homelab#347 |
| F-6 | **에러 포매터의 Proxy 잔여** — 살아있는 Proxy의 `getOwnPropertyDescriptor` trap이 첨부된 크리덴셜을 `message`인 척 own 데이터 서술자로 합성해 반환하면 현재 헬퍼가 수용한다. JS에서 임의 값의 프로퍼티를 trap 없이 읽는 방법이 없어 구조적 한계이며, 위협 모델상 공격자 코드가 이미 in-process여야 성립한다(수동적 유출 = pg가 진짜 Error에 password를 첨부하는 케이스는 완전히 닫힘). release 게이트 r6가 이를 지적했으나 엔진 장애로 형식 판정 불가 → 사람이 waive. **재평가 조건**: 게이트 엔진이 이 브랜치를 완주할 수 있게 되면 재리뷰 / 또는 진단 손실 없이 닫는 방법이 나오면 재검토 | release gate r6 (waived) | 재리뷰 대기 |
| F-7 | **worker 아키타입에 테스트가 없다** — 포매터의 읽기 규율이 worker에도 복사되지만, worker엔 test 스크립트가 없어(Dockerfile 게이트 목록이 typecheck+build뿐) 드리프트를 CI가 잡지 못한다. api의 같은 코드가 간접 증명할 뿐 | R-9 라운드 관찰 | 별도 판단 |
| F-5 | ✅ **처리됨(2026-07-13)** — homelab의 `reusable-app-build`에 `push` 입력(기본 true) 추가(homelab#354), 템플릿이 `scaffold/common/.github/workflows/pr.yaml`을 동봉(#18) — `push: false`(BUILD ONLY)로 호출하는 thin-caller다. 릴리스와 **같은 빌드**를 PR에서 돌리되 GHCR·배포는 안 건드린다. `permissions: contents: read` 하나 + 시크릿 0개 — **토큰에 packages 스코프가 없어 build-only run은 밀고 싶어도 못 민다**(reusable이 잡 permissions를 일부러 선언하지 않아 상한을 caller가 정한다; permissions는 표현식 불가 + called가 caller 상한을 넘기면 run 자체가 죽는다). template-ci에 가드 2종 추가: shipped 워크플로 actionlint(지금껏 무검사였다) + **착지 단언**(자가삭제 단언의 대칭짝 — pr.yaml이 빠지면 앱 PR이 체크 0개로 되돌아가는데 다른 검증은 전부 초록이라 관측점이 여기뿐이다). 기존 앱 `page`에도 적용(page#11) — **첫 실행 실증: `build/build: success`, `build/deploy-trigger: skipped`**. `trip-mate-api`는 자체 ci.yml이 이미 있어 대상 아님 | I-6 code-review | homelab#354, #18, page#11 |
| F-4 | ✅ **처리됨(2026-07-13, PR #17)** — (a) 템플릿 자신의 의존성이 정체하고 있었다(앱과 **같은 결함**): `package.json`이 `yaml: ^2.4.0`, `bun.lock`이 2.9.0(범위 안)인데도 갱신 브랜치가 아예 안 만들어졌다 — bun 매니저가 lockfile-only 갱신 경로를 구현하지 않기 때문. `rangeStrategy: bump` + `lockFileMaintenance` 추가로 `renovate/yaml-2.x`·`typescript-5.x`가 흐르기 시작. (b) `github-actions` 비활성 — 켜둔 상태에선 ① 토큰에 `workflows:write`가 없어 `template-ci.yaml`의 액션 SHA 핀 갱신 PR이 매주 push에서 죽고, ② 더 나쁘게 `scaffold/common/.github/workflows/release.yaml`(**템플릿 자산**)의 `reusable-app-build@main`을 SHA로 핀하려 해 **모든 생성 앱이 homelab main SSOT를 못 따라가고 스냅샷에 얼어붙는다**. 실 Renovate 실행으로 워크플로 파일 0건 확인. (c) customManagers는 I-7이 이미 처리 | I-6 code-review | PR #17 |
| F-3 | Bun이 pg pool의 unhandled `error` throw를 **무음으로 삼키는** 동작(소켓 콜백 경로) — pg/Node 계약 위반으로 보이며 업스트림(Bun) 리포트 가치가 있다. 또한 Bun 인스펙터가 에러 객체 로깅 시 pg `Client`를 덤프해 **DB 비밀번호를 평문 노출**한다(실 Postgres 재현). 두 건 모두 이 레포에서는 방어됐으나(리스너 + 구조분해 로깅 + 회귀 테스트) 다른 앱·다른 라이브러리에서 재발 가능 | I-3 실행 중 발견 | 업스트림 리포트 |
| F-2 | ✅ **처리됨(2026-07-13, PR #16)** — 우선순위를 **반전**했다: 플랫폼이 주입한 접두사 키가 이기고 generic `DATABASE_URL`은 fallback이다. 실측으로 옛 동작이 footgun임을 확인(접두사=live + generic=dead → 옛 코드 `/readyz` 503). 실제 앱 `page`가 이미 반대로 구현·테스트하고 있어 템플릿만 어긋나 있었다. 반전이 연 새 구멍(접두사 없는 `MIGRATE_`/`RO_`가 generic을 이겨 **풀러 우회 → max_connections 고갈**)도 함께 막았고, 후보가 둘 이상이면 fail-closed로 던진다(탈출구: `createApp(pool)`). `secret:seal`이 DB URL 키 봉인 시 경고. **문서 사실 오류 2건 정정**: 접두사는 앱 이름이 아니라 **DB 이름**에서 온다(앱 `trip-mate-api` → `TRIP_MATE_DATABASE_URL`); `_MIGRATE_`는 다른 롤이 아니라 같은 owner 롤의 **직결** 연결이다 | I-2 code-review (spec axis) | PR #16 |
