---
feature: template-hardening
invariant-class: feature      # Rule 0: 리뷰 확정 13건 배치 — >1 behavior flips (SIGTERM/pg-error/CI 게이트/Renovate 등)
entry-track: feature          # feature | architecture | inbound | bug
review-track: standard        # light | standard | full — 기존 템플릿 hardening 배치, 신규 skeleton 구조 없음
pipeline-stage: intake        # the enum stage this track currently sits at
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
