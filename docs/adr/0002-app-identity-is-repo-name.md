# 앱 식별자는 레포명이다 — 스캐폴드는 유도·경고만 하고, 강제는 create-app이 한다

배포 식별자(이미지 경로, SealedSecret `<app>-secrets`, 라우트)는 GitHub 레포명
하나에서 파생되며 homelab create-app.ts가 `repoName === app`을 하드 강제한다.
스캐폴드는 이 이름을 `git remote origin` URL에서 유도하고(없으면 디렉토리명
fallback), 사용자가 다른 이름을 입력하면 "배포 식별자가 아니다"라고 stderr로
경고만 한다 — 하드 실패시키지 않는다. `secret:seal` 스크립트에는 유도된 이름을
`--app`으로 베이크해 cwd 디렉토리명 의존을 제거한다.

## Considered Options

- **불일치 시 하드 실패**: 이 레포의 fail-closed 성향에는 부합하지만, CI가
  임시 디렉토리에서 `--name ci-<archetype>`로 스캐폴드하는 정당한 사용처와
  클론 디렉토리명이 다른 경우를 전부 막는다. 최종 강제는 어차피 create-app에
  존재하므로 이중 하드 게이트의 실익이 마찰보다 작다. 기각.
- **--name 완전 제거**: 계약은 가장 단순하나 CI 네거티브 테스트(`--name Bad_Name`)
  재설계가 필요하고 유연성을 잃는다. 기각.

## Consequences

- fail-closed 레포에서 "경고만"은 의외로 보일 수 있다 — 이유는 하단(create-app)에
  이미 하드 게이트가 있고, 스캐폴드 시점의 이름은 표시용(package.json/README)이기
  때문이다. 같은 논리로 비호환 플래그(`--metrics`/`--public`)도 경고로 처리한다
  (unknown flag는 기존대로 exit 2 — 그건 오타이지 의도가 아니다).
