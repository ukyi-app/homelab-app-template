---
feature: template-hardening
invariant-class: feature      # Rule 0: 리뷰 확정 13건 배치 — >1 behavior flips (SIGTERM/pg-error/CI 게이트/Renovate 등)
entry-track: feature          # feature | architecture | inbound | bug
review-track: standard        # light | standard | full — 기존 템플릿 hardening 배치, 신규 skeleton 구조 없음
pipeline-stage: executing     # PRD 확정(plan gate r3 approve) → 이슈 DAG 실행 중
worktree: .worktrees/template-hardening
branch: template-hardening
consent-scope: |
  2026-07-12 사람 동의: 이슈 I-1~I-7을 워크트리 .worktrees/template-hardening
  (브랜치 template-hardening, base main)에서 직렬 실행. 이슈당 신선한 구현
  서브에이전트 디스패치(tdd, PRD 사전 합의 seam) → 컨덕터측 code-review
  (Spec 먼저 clean → Standards) → 커밋 + 이슈 클로즈. main 직접 커밋 금지,
  병합은 landing 단계에서 별도 확인.
issue-tracker: none
prd-published: false
inbound-issue:                # inbound track only
intake-grill:                 # "done" on the architecture track → intake runs capture-only
spike-1:                      # <path>@pending | @done | @deleted
---

## Track note

2026-07-10 멀티에이전트 리뷰(58 에이전트, find → adversarial verify → completeness
critic)에서 확정된 13건의 개선 사항을 하나의 feature 배치로 진행한다. 발견 사항
전문은 `review-findings.md`(동일 디렉토리, 커밋됨) — intake(grill-with-docs)의
입력 자료다. 핵심 축: (1) 생성된 앱의 런타임 결함(SIGTERM 미처리, pg Pool error
리스너 부재), (2) 배포 수명주기 공백(typecheck 게이트·Renovate·스모크 테스트
부재), (3) DX/문서 정합(dev 스크립트, .env.example, README 오기).

**Intake 완료(2026-07-10)** — 그릴 결정 사항:
- 배치 구조 A: 단일 PRD + 통합 슬라이스(~7개). 2-웨이브/3-PRD 기각.
- F3 게이트 = Dockerfile 내장(ADR-0001). F9 = origin 유도 + 경고 + secret:seal
  `--app` 베이크(ADR-0002). F10 = stderr 경고(unknown flag는 exit 2 유지).
- F13b = app export(`import.meta.main` 가드) + healthz 스모크 + api runtimeUrl
  단위 테스트, api·fullstack Dockerfile에 `bun test` 포함. worker·site 테스트 없음.
- F5 = 4개 아키타입 전부 스모크 런, site는 최소 args(--port/--root/--health).
- F6 = concurrently devDep. F13a = template-ci grep 가드(bun 버전 6곳 정합).
- 탈락 항목 중 scaffold.ts "재시도 가능" 주석 한 줄 정정만 포함.
- Out-of-scope: homelab RENOVATE_REPOSITORIES 배선(done 단계에서 homelab에
  follow-up 파일), 리뷰 탈락 10건.
- 용어·ADR: CONTEXT.md 신설, docs/adr/0001·0002 — 본 커밋에 포함(pre-prd-gate,
  base branch — 하드 룰 9 준수).
