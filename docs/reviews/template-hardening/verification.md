# template-hardening — 검증 증거

**검증 대상 커밋**: `104ee90` (브랜치 `template-hardening`, 8개 이슈 전부 클로즈)
**검증 일시**: 2026-07-12
**주장의 출처**: 클로즈된 8개 이슈(I-1~I-8)의 수용 기준 47개 — `docs/issues/template-hardening/I-*.md`
**원칙**: 모든 명령을 이 검증에서 **새로 실행**했다. 서브에이전트 보고는 증거로 채택하지 않았다.
회귀 방어선은 **red-green으로 증명**한다 — 수정을 되돌리면 반드시 빨개져야 하고, 빨개지지 않는
가드는 증거가 아니라 장식이다.

**결과: 47/47 통과. 실패 0.**

> 하네스 자체가 두 번 자기 버그를 드러냈고 그때마다 고쳐 다시 돌렸다:
> ① 가드 테스트에 1글자 앱 이름(`a`)을 써서 `NAME_RE` 검증(exit 2)이 가드보다 먼저 걸렸다 —
> I-5/I-8 가드의 "네거티브 통과"는 **거짓 통과**였고 가드가 물었는지는 증명되지 않은 상태였다.
> 유효한 이름으로 바꾸고 **종료 코드 + 메시지 조각**을 함께 단언하도록 고쳤다.
> ② CI 자가삭제 단언을 YAML에서 추출할 때 스텝 전체(`cp -r . /tmp/app` 포함)를 잡아 정상 앱에서도
> 실패했다. 단언 부분만 추출해 재실행했다.

---

## 1. 런타임 계약 — 스모크 런 (I-1, I-7)

빌드된 이미지를 실제 기동해 검증. 프로브 경로는 **생성된 `.app-config.yml`에서 유도**한다(하드코딩 아님).

| 명령 | 결과 |
|---|---|
| `docker run` + `curl $(yq .probes.liveness.path)` (fullstack) | `/healthz` → 본문 `ok` |
| 〃 readiness (fullstack) | `/readyz` → 본문 `ready` |
| `docker stop -t 30` (fullstack) | **1s, exit 0** (유예 30s 대비) |
| 〃 (api) | `/healthz`→`ok`, `/readyz`→`ready`(무DB 정적 통과), **1s, exit 0** |
| worker: tick 확인 후 `docker kill -s TERM` → `docker wait` | **125ms, exit 0, `worker stopped` 로그** |
| site: `--port 8080 --root /public --health` 로 기동 | `/health` → 200 |
| site: `/` 본문에 앱의 `<title>homelab site` 포함 | PASS (SWS 기본 페이지가 아님을 확인) |

### RED 증명 — pre-I-1 코드로 되돌리면 잡히는가
```
$ git show e9f3e10:scaffold/archetypes/worker/src/index.ts > src/index.ts   # I-1 이전 worker
$ docker build ... && docker run -d && docker kill -s TERM && docker wait
→ 4758ms 소요
```
**PASS** — 상한 2s를 크게 넘겨 스모크가 잡는다(정상 코드 125ms). 이 상한이 없었다면 "빌드는 초록,
파드는 롤아웃마다 유예시간을 태우는" 회귀가 그대로 통과했을 것이다.

## 2. Dockerfile 게이트 (I-2)

| 명령 | 결과 |
|---|---|
| `docker build --platform linux/arm64` × 4 아키타입 | 4/4 성공 (이미지 빌드 안에서 typecheck·test 실행) |
| `bun test` (api) | **13 pass / 0 fail** |
| `bun test` (fullstack) | **4 pass / 0 fail** |
| `bun run typecheck` × 4 | 4/4 exit 0 |
| `bun run build` × 4 | 4/4 exit 0 |

### RED 증명 — 게이트가 실제로 무는가
```
$ echo 'export const boom: number = "not a number";' >> src/index.ts
$ docker build ...
→ rc=1  (RUN bun run typecheck 에서 실패)

$ printf 'test("의도적 실패",()=>{expect(1).toBe(2)})' > src/red.test.ts
$ docker build ...
→ rc=1  (RUN bun run test 에서 실패)
```
**PASS ×2** — 타입 에러도 테스트 실패도 이미지 빌드를 막는다. GHCR push·autoDeploy에 도달하지 못한다.

## 3. pg 풀 오류 격리 + DB 복구 시퀀스 (I-3)

`bun test`(api)가 실행하는 13개 중 관련 테스트:
```
liveness는 DB와 무관하게 200
readiness — 무DB면 정적 통과
readiness — 주입된 풀로 SELECT 1을 왕복하고 200
readiness — 주입된 풀의 왕복이 실패하면 503
주입된 풀도 프로덕션과 같은 준비 경로를 통과한다 — error 리스너가 붙는다
복구 시퀀스 — 같은 풀로 error 생존 → readiness 503 → 회복 200
```

### RED 증명 — 리스너를 제거하면 빨개지는가
```
$ perl -0pi -e 's/pool\?\.on\("error".*?\}\);//s' src/db.ts   # 리스너 제거
$ bun test
→ rc=1  (실패)
```
**PASS** — 리스너가 load-bearing임이 증명된다. 상태 있는 스텁 풀 **하나**와 app **하나**로
error → 생존 → 503 → **같은 풀** 회복 → 200 전 시퀀스를 관통한다(별개 인스턴스로 눈속임하지 않음).

## 4. 스캐폴더 (I-4)

| AC | 명령 | 결과 |
|---|---|---|
| AC1 origin 유도 | 디렉토리 `o1`, origin `git@github.com:ukyi-app/my-real-app.git` → 스캐폴드 | `package.json name: "my-real-app"` (디렉토리명 아님) |
| AC1 fallback | `.git` 없음(CI 경로) → 스캐폴드 | exit 0, 디렉토리명 fallback, 크래시 없음 |
| AC2 불일치 경고 | origin `real-name` + `--name ci-api` | **exit 0** + stderr: `⚠️ 앱 이름 'ci-api'이(가) 유도값 'real-name'와 다르다 — 이 값은 배포 식별자가 아니며 GitHub 레포명과 같아야 한다(create-app이 repoName === app을 강제)` |
| AC3 봉인 이름 | 디렉토리명 `seal` ≠ 앱 이름 `ci-api`, `bun run secret:seal` 실행(실제 kubeseal) | 산출물 `deploy/ci-api-secrets.sealed.yaml`, `metadata.name: ci-api-secrets` — **앱 이름 기준**(cwd 아님) → create-app의 `<app>-secrets` 검사 통과. 평문 유출 0 |
| AC4 비호환 플래그 | `--archetype worker --metrics --public --yes` | **exit 0** + stderr 경고 2건, `.app-config.yml`에 metrics/route **미반영**(조용한 드롭 아님) |
| AC5 오타 flag | `--no-autodeplpy --yes` | **exit 2** (`알 수 없는 옵션`) |
| AC5 불량 name | `--name Bad_Name --yes` | **exit 2** (`앱 이름 불량`) |
| AC6 롤백 정직성 | 존재하지 않는 dep 주입 → `bun install` 실패 | 아래 참조 |
| AC7 | 4개 아키타입 비대화형 스캐폴드 | 4/4 exit 0 |

### AC6 — 롤백 메시지가 사실인가 (강제 실패)
```
$ bun run scaffold --archetype api --name ci-api --yes
❌ bun install(lock 재생성) 실패 — 새로 생긴 루트 엔트리만 제거했다. 제자리 수정(package.json·
README.md·.gitignore·renovate.json, 경우에 따라 bun.lock)과 .github/workflows/release.yaml은 남아
있고, package.json 재작성으로 scripts.scaffold가 지워져 `bun run scaffold`는 더 이상 없다 —
`git checkout . && git clean -fd`로 트리를 되돌려야 재실행할 수 있다(...)

$ git status --short
 M .gitignore
 M README.md
 M package.json
 M renovate.json
?? .github/workflows/release.yaml       ← 열거한 그대로. D 라인 0개.

$ git checkout . && git clean -fd && grep '"scaffold"' package.json
→ 진입점 부활
```
**PASS** — 메시지가 열거한 잔여물이 실제와 정확히 일치하고, 메시지가 안내한 복구 명령이 실제로 작동한다.

## 5. DX·문서 (I-5)

| AC | 결과 |
|---|---|
| AC1 fullstack dev | `package.json`에 `dev` 스크립트 + `concurrently` devDep |
| AC2 .env.example | 4개 앱 전부 존재, gitignore 안 됨 |
| AC3 봉인 3단계 | `secret:seal --dry-run` → 키 목록만 출력(값 미포함): `{"seal":["API_TOKEN","DB_PASSWORD"]}`. 실제 봉인 → `deploy/<app>-secrets.sealed.yaml` |
| AC4/AC5 README 정합 | 4개 앱 전부 미치환 `{{...}}` **0건**. 아키타입별 런타임·명령 문구 렌더 |
| AC6 | 4개 스캐폴드 성공 + 계약 검증 유지 |

### RED 증명 — 드리프트 가드가 무는가
| 주입한 드리프트 | 결과 |
|---|---|
| `package.partial.json`에서 `test` 스크립트 제거 (DOC는 여전히 약속) | **exit 1** (`템플릿 버그`) |
| Dockerfile에서 `RUN bun run test` 삭제 (DOC의 게이트 목록과 불일치) | **exit 1** (`게이트` 불일치) |
| `README.app.md`의 `{{APP}}` → `{{APPP}}` 오타 | **exit 1** (`자리표시자`) |

**PASS ×3** — 산문이 조용히 거짓이 되는 것을 기계가 막는다(exit 1 = 템플릿 버그, exit 2 = 사용자 입력 오류로 코드 분리).

## 6. Renovate 동봉 (I-6)

| AC | 결과 |
|---|---|
| AC1 | 4개 아키타입 앱 루트 전부에 `renovate.json` |
| AC2 | 앱 설정 == `scaffold/common/renovate.json` (byte-identical) |
| AC3 | 스캐폴드 성공·자가삭제·lock 재생성 경로 무영향 |

핵심 설정 확인: `"rangeStrategy": "bump"` (Renovate의 bun 매니저가 `updateLockedDependency`를
구현하지 않아, 이게 없으면 캐럿 범위 의존 = **CVE 픽스 대부분**이 영구 정체한다),
`"automerge": false` (앱엔 PR CI가 없어 Renovate가 체크 0개 브랜치를 green으로 보고,
머지 = GHCR push = autoDeploy = 프로덕션 배포다).

## 7. template-ci 강화 (I-7)

| AC | 결과 |
|---|---|
| AC1~AC4 스모크 런 | §1 참조 — 4개 아키타입 전부 |
| AC5 액션 SHA 핀 | 이동 태그 **0건**. `actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1`, `oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0` |
| AC6 bun 정합 | 4개 Dockerfile 태그 == `.bun-version`(1.3.14). 워크플로에 버전 하드코딩 **없음**(`bun-version-file`로 읽음) |
| AC7 DX 존재 계약 | fullstack의 dev·concurrently 단언 |
| AC8 기존 검사 보존 | 스키마 검증·네거티브·풀러-안전 grep·타입검사·strict-parse 전부 유지 |

### RED 증명 — bun 정합 가드
CI의 가드 스텝을 YAML에서 **원문 추출**해 `bash -eo pipefail`로 실행:
```
$ sed -i 's/^FROM oven\/bun:1.3.14/FROM oven\/bun:1.3.13/' scaffold/archetypes/api/Dockerfile
$ <가드 스텝 원문>
→ rc=1   (Dockerfile 1곳만 범프 → 불일치 감지)

$ <같은 가드를 현재 트리에서>
→ rc=0   (오탐 없음)
```
**PASS** — 부분 범프가 "lock 재생성 bun ≠ frozen-lockfile 빌드 bun"을 조용히 만드는 것을 막는다.

## 8. 템플릿 전용 문서 누출 차단 (I-8)

| AC | 결과 |
|---|---|
| AC1/AC3 | 4개 앱 전부: `docs/`·`CONTEXT.md`·`.bun-version`·`scaffold/`·`template-ci.yaml` **부재**; 앱 필수 파일 11종 전부 존재 |
| AC2 | ADR 처리 방침 결정·기록(I-8 Result 참조) |
| AC4 | 템플릿 레포는 `docs/`·`CONTEXT.md` 온전 |
| AC5 | 삭제가 `bun install` 성공 이후 — §4의 강제 실패에서 **`D` 라인 0개**(docs/·CONTEXT.md 생존) |
| AC6 | 4개 스캐폴드·docker build·테스트·네거티브 전부 유지 |

### RED 증명 — CI 자가삭제 단언이 무는가
```
$ (정상 앱 4개에서 단언 원문 실행) → 4/4 exit 0
$ mkdir docs && echo x > docs/prd.md && <단언>
::error::자가삭제 누락 — 템플릿 전용 파일이 앱에 남았다: docs
→ rc=1
$ echo x > CONTEXT.md && <단언>
::error::자가삭제 누락 — 템플릿 전용 파일이 앱에 남았다: CONTEXT.md
→ rc=1
```
**PASS** — 삭제가 깨지면 CI가 어느 파일이 남았는지 이름을 대고 실패한다.

### RED 증명 — SELF_DELETE 충돌 가드
```
$ mkdir -p scaffold/common/docs && echo x > scaffold/common/docs/x.md
$ bun run scaffold --archetype api --name ci-api --yes
→ exit 1 (템플릿 버그: ROOT/docs가 되지만 그 경로는 통째로 지워진다)

$ echo x > scaffold/common/CONTEXT.md
→ exit 1
```
**PASS ×2** — 통째 삭제가 만든 함정(앱용 문서를 두면 무음 삭제)을 가드가 닫는다. 정상 경로 오탐 0.

---

## 검증하지 못한 것 (정직한 공백)

- **GitHub Actions 실행 자체**: 로컬에서 러너를 띄울 수 없어, CI 스텝의 `run:` 블록을 YAML에서
  원문 추출해 `bash -eo pipefail`(러너의 기본 셸 의미론)로 실행하는 방식으로 대체했다. 러너 환경
  특유의 실패(네트워크, `ubuntu-24.04-arm` 이미지 차이)는 첫 CI 실행에서만 드러난다.
- **homelab 클러스터 배포**: 실제 k3s 배포·차트 연동은 이 레포 밖이다. 차트가 소비하는
  `.app-config.yml`의 스키마 적합성은 template-ci가 homelab 스키마(@main)로 검증한다.
- **Renovate 실제 PR 생성**: dry-run으로 브랜치/파일 집합을 확인했으나, 실제 GitHub에서의 토큰
  권한·PR 생성은 F-1(레포 등록) 이후에만 관측 가능하다.
