# homelab-app-template

homelab k3s 클러스터에 배포되는 앱을 스캐폴드하는 템플릿 레포. 여기서 생성된
앱 레포는 homelab 인프라 레포의 계약(.app-config.yml 스키마, 공유 차트, create-app
온보딩)을 소비한다.

## Language

**앱 이름 (app name)**:
GitHub 레포명. 배포 식별자의 단일 원천 — 이미지 경로, SealedSecret 이름
(`<앱 이름>-secrets`), 라우트가 전부 여기서 파생되며 homelab create-app이 강제한다.
_Avoid_: package name, 표시 이름, `--name` 값 (셋 다 배포 식별자가 아니다)

**아키타입 (archetype)**:
스캐폴드 시점에 선택하는 앱 형태(fullstack / api / site / worker). 생성되는
코드·Dockerfile·런타임 계약을 결정한다.
_Avoid_: kind (아키타입에서 유도되는 별개 개념), 템플릿 종류

**kind**:
배포 계약(.app-config.yml)의 런타임 분류(web / site / worker). homelab 공유 차트가
소비한다. 아키타입에서 유도된다(fullstack·api → web).
_Avoid_: 아키타입과 혼용

**런타임 계약 (runtime contract)**:
kind별로 차트가 기대하는 기동 표면. web: `:8080` + `/healthz`(liveness)·`/readyz`
(readiness), opt-in metrics `:9090`. site: 정적 서버의 `/health`. worker: HTTP
비서빙, SIGTERM에 유예시간 내 정상 종료. 모든 kind 공통: PID 1로 실행되므로
SIGTERM 핸들러는 계약의 일부다.

**스캐폴드 (scaffold)**:
템플릿 레포를 배포 가능한 앱 레포로 변환하는 1회성 자가삭제 절차. 실행 후
템플릿 전용 머시너리도, 템플릿 전용 문서도 앱 레포에 남지 않는다 — 앱이 받는
문서는 앱 자신을 설명하는 것뿐이다.

**Dockerfile 게이트 (Dockerfile gate)**:
이미지 빌드 자체에 내장된 품질 관문(typecheck, 테스트). 워크플로가 아니라
Dockerfile에 살기 때문에 어떤 빌드 경로(release CI, template-ci, 로컬)로 빌드해도
우회할 수 없다.
_Avoid_: preflight 잡 (거부된 대안 — ADR-0001)

**스모크 런 (smoke run)**:
빌드된 이미지를 실제로 기동해 런타임 계약의 첫 부팅을 검증하는 template-ci 스텝.
"빌드는 통과하나 기동은 실패"하는 부류의 회귀를 잡는다.

**드리프트 가드 (drift guard)**:
template-ci의 존재 이유 — 템플릿 산출물이 homelab 계약(@main 스키마, bun 버전
정합)과 계속 일치함을 push·PR·주간 크론으로 재검증한다.

**봉인 (sealing)**:
`.env`의 UPPER_SNAKE 키·값을 SealedSecret로 변환하는 절차. `.env`가 봉인 대상의
SSOT이며, 산출물 이름은 앱 이름에서 파생된다.
