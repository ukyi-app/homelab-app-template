# typecheck·테스트 게이트는 CI 잡이 아니라 Dockerfile에 내장한다

release.yaml은 의도적으로 thin-caller다(빌드 로직 SSOT = homelab
reusable-app-build.yaml@main, b8eb515). 배포 전 typecheck/테스트 게이트가 필요해
졌을 때 CI preflight 잡을 앱마다 복사하면 이 원칙이 깨지고 포크 드리프트 표면이
다시 커진다. 대신 각 아키타입 Dockerfile의 build 앞에 `RUN bun run typecheck`
(+테스트가 있는 아키타입은 `bun test`)를 넣는다 — 이미지 빌드 자체가 게이트가
되므로 release CI, template-ci, 로컬 빌드 어느 경로로도 우회할 수 없고, 이 레포
안에서 완결된다.

## Considered Options

- **release.yaml preflight 잡**: 실패 피드백은 빠르지만 thin-caller를 재비대화 —
  앱마다 복사·포크되는 워크플로 드리프트가 재발한다. 기각.
- **homelab reusable-app-build.yaml에 preflight 추가**: 기존 앱 전체가 혜택을 보는
  진짜 SSOT이지만 교차-레포 변경이라 이 배치의 게이트 범위 밖. 필요해지면 후속으로
  이관 가능(그때 Dockerfile 쪽 줄을 빼면 된다).

## Consequences

- 타입 에러·테스트 실패 시 이미지 빌드가 실패한다 — GHCR push·autoDeploy까지
  도달하지 못한다(의도된 동작).
- 이미지 빌드 시간이 소폭 늘고, 실패 로그가 docker build 출력 안에 있다.
- 스캐폴드된 앱이 이 Dockerfile을 포크해 가므로, 게이트 위치를 나중에 바꿔도
  기존 앱에는 전파되지 않는다(이 결정이 사실상 비가역인 이유).
