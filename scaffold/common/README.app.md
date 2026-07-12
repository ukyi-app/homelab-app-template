# {{APP}}

homelab 앱 (아키타입: **{{ARCHETYPE}}**) — `homelab-app-template`으로 스캐폴드됨.

## 개발
```bash
bun install
{{DEV_CMDS}}
```
{{DEV_NOTE}}

## 비밀 값
비밀 값은 코드에도 `.app-config.yml`에도 두지 않는다. `.env`가 '무엇을 봉인할지'의 SSOT이고,
레포에 들어가는 건 봉인된 산출물뿐이다.

1. **`.env` 작성** — `cp .env.example .env` 후 필요한 키만 채운다. 키는 UPPER_SNAKE여야 한다
   (그 외는 봉인이 거부). `.env`는 gitignore된다 — 커밋되는 건 값이 빈 `.env.example`뿐이다.
2. **봉인** — `bun run secret:seal` (로컬에 `kubeseal` CLI 필요).
   `.env`의 모든 키를 `tools/sealed-secrets-cert.pem`으로 암호화해
   `deploy/{{APP}}-secrets.sealed.yaml`에 쓴다. 평문 Secret은 디스크를 거치지 않고 kubeseal stdin으로만
   흐른다. `bun run secret:seal --dry-run`은 봉인 없이 대상 키 목록만 보여준다(값 미포함).
3. **커밋** — `deploy/{{APP}}-secrets.sealed.yaml`을 커밋·push한다. 클러스터의 sealed-secrets
   컨트롤러만 복호화할 수 있으므로 레포에 있어도 안전하다.

키를 추가·삭제하면 1~3을 다시 돈다 — 봉인 산출물은 `.env` 전체의 스냅샷이지 증분이 아니다.
{{SECRET_NOTE}}

## 배포
1. `main`에 push → GitHub Actions가 GHCR에 arm64 이미지 빌드·push
2. owner가 homelab에서 `create-app` 디스패치 → 첫 배포 🚀
3. 이후 main 머지마다 homelab GHCR 폴링이 자동 배포(autoDeploy 시)

Dockerfile 게이트 — 관문은 CI 잡이 아니라 이미지 빌드 안에 있다. {{GATES}} 중 하나라도 실패하면
빌드가 깨져 GHCR에 도달하지 못한다(우회 경로 없음).

## 계약
- `.app-config.yml` = 배포 계약(`kind`/`resources`/`route` 등)
- 런타임: {{RUNTIME}}
- 앱 이름(`{{APP}}`) = GitHub 레포명 — 배포 식별자의 단일 원천이고 `create-app`이 `repoName === app`을 강제한다.
  레포를 rename하면 `package.json`의 `name`, `secret:seal`의 `--app` 값, `deploy/{{APP}}-secrets.sealed.yaml`
  파일명을 새 레포명으로 함께 고치고 다시 봉인한다.
