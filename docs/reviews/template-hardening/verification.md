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

## 9. 실제 GitHub Actions 실행 (release 게이트 R-3)

r1 게이트가 "CI가 실제 러너에서 한 번도 돌지 않았다 — I-7의 'CI가 green이다' AC가 미증명"이라고
지적했다(정당한 지적이었다: 로컬 대체 검증은 액션 입력값·matrix·러너 환경을 실행하지 않는다).
브랜치를 push해 PR #14로 template-ci를 **실제 `ubuntu-24.04-arm` 러너에서** 실행했다.

**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29195573415
**SHA**: `3df189b` (release 게이트 수정 R-1/R-2/R-4 포함)

| 잡 | 결과 |
|---|---|
| `scaffold-build (fullstack)` | **pass** (36s) |
| `scaffold-build (api)` | **pass** (34s) |
| `scaffold-build (site)` | **pass** (31s) |
| `scaffold-build (worker)` | **pass** (34s) |
| `scaffold-args` | **pass** (7s) |

스모크 단언이 **실제로 실행**됐음을 러너 로그로 확인(스킵된 초록이 아님):
```
✅ /healthz → 200 'ok'          (api — .app-config.yml에서 유도한 경로)
✅ /readyz → 200 'ready'
✅ worker: SIGTERM → 121ms 만에 종료(exit 0, 상한 2s, 주기 5000ms) + 'worker stopped'
✅ site: /health → 200, / → 200(<title>homelab site</title> 확인), 없는 경로 → 404
✅ bun 정합: 5곳(Dockerfile 4 + .bun-version) 모두 1.3.14
✅ api 풀러-안전(statement_timeout startup 미전송) + readiness 배선 확인
```

## 10. release 게이트 r1 수정의 검증 (R-1 / R-2 / R-4)

### R-1 — 비권위적 `--name`이 배포 시크릿을 결정하던 문제
게이트 지적: 스캐폴더가 "이 값은 배포 식별자가 아니다"라고 **경고해놓고 그 값을 `secret:seal --app`에
베이크**해, origin `real-name` + `--name ci-api`면 `ci-api-secrets`가 나오는데 create-app은
`real-name-secrets`를 요구한다(하드 리젝). 검증이 두 픽스처를 분리해 이 교차 케이스를 놓쳤다.

수정 후 실측(kubeseal 실행):
```
origin=real-name, --name ci-api → exit 0 + 불일치 경고
  package.json name : ci-api                              (표시 이름)
  secret:seal       : --app real-name                     (배포 식별자)
  kubeseal 산출물   : deploy/real-name-secrets.sealed.yaml
  metadata.name     : real-name-secrets                   ← create-app이 요구하는 값
BEFORE(수정 전)     : deploy/ci-api-secrets.sealed.yaml   ← 온보딩 리젝
```
**PASS** — 배포 이름은 모든 경로에서 NAME_RE 검증을 거치며, `--name`이 절대 바꿀 수 없다.

### R-2 — 사용자 파일 무음 삭제
게이트 지적: `docs/`를 통째로 지우는 삭제가, 사용자가 스캐폴드 **전에** 넣어둔 자기 파일까지
경고 없이 파괴한다.
```
$ echo "내 메모" > docs/my-notes.md && bun run scaffold --archetype api --name ci-api --yes
→ exit 2, docs/my-notes.md 생존, src/ 미생성, README.md 미덮어씀
   메시지가 파괴될 파일을 이름으로 지목하고 "옮긴 뒤 다시 실행해라. 아무것도 건드리지 않았다"
```
**PASS** — 귀속 기준은 **이 레포의 최초 커밋 트리**라 코드에 목록을 베끼지 않는다(템플릿 문서가
늘어도 낡지 않는다). 정상 경로(사용자 파일 없음) 오탐 0 — 실제 CI 4개 잡이 이를 증명한다.

> 게이트가 함께 제기한 "히스토리 오염"(템플릿 레포 복사 시점의 초기 커밋에 이미 문서가 들어 있다)은
> **기각**했다: GitHub 템플릿 복사는 이 레포 밖 동작이고, 초기 커밋 재작성은 스캐폴더의 일이 아니다.

### R-4 — worker가 원시 에러 객체를 로깅
게이트 지적: 이 브랜치의 `db.ts`가 **바로 그 패턴이 Bun에서 DB 비밀번호를 평문 노출함을 재현·문서화**
해놓고, worker의 catch에는 같은 패턴을 그대로 뒀다.

sentinel 크리덴셜을 첨부한 에러를 스크래치 사본에 주입해 실 컨테이너 로그 확인:
```
BEFORE:  error: boom
           client: { password: "SENTINEL_pw_9z" },     ← 유출
AFTER:   tick failed (code=X1): Error: boom
             at /$bunfs/root/app:28:34                  ← 크리덴셜 부재, message·code 보존
         (프로세스 생존 + 1s 백오프로 재시도 계속)
```
**PASS** — `SENTINEL_pw_9z` 부재, `code=X1`·message 보존, 예외 반복에도 프로세스 생존.

## 11. release 게이트 r2 수정의 검증 (R-5 / R-6)

r2 게이트는 r1 수정 중 **두 건이 새 결함을 만들었음**을 잡았다. 둘 다 정확했다.

### R-5 — 사용자 파일 보호 가드에 우회가 있었다 (high)
게이트 지적: R-2 가드가 **ignore된 untracked 파일을 전부 "템플릿이 실은 것"으로 분류**해 삭제 가능
집합에 넣었다. 이 레포는 `*.local`·`.env`·`.env.*`를 ignore하므로, 사용자가 손으로 쓴
`docs/notes.local`·`docs/.env`가 preflight를 통과한 뒤 `docs/`와 함께 조용히 삭제됐다.
r1의 증거는 **ignore되지 않은** `docs/my-notes.md`만 테스트해 이 우회를 통째로 놓쳤다.

| 케이스 | BEFORE (r1 수정본) | AFTER |
|---|---|---|
| `docs/notes.local` (ignored) | **exit 0 — 파일 소멸, 경고 없음** | **exit 2**, 파일 생존, 전개 흔적 0 |
| `docs/.env` (ignored) | **exit 0 — 파일 소멸** | **exit 2**, 파일 생존 |
| `docs/my-notes.md` (비-ignore) | exit 2 | exit 2 (약화되지 않음) |
| `docs/.DS_Store` 단독 | — | exit 0 (막지 않음) |
| `.DS_Store` + `notes.local` | — | **exit 2**, 메시지는 `notes.local`만 지목 |
| 정상 경로(템플릿 docs만) | — | exit 0 |

**PASS** — ignore 상태를 소유권의 대리물로 쓰지 않는다. 최초 커밋 트리에 없으면 무조건 사용자
소유이고, 예외는 basename 정확 일치 화이트리스트(`.DS_Store`, `Thumbs.db`)뿐이다.
부수 발견: 이 레포 `.gitignore`엔 `.DS_Store`가 없어서, 기존 "편의"는 **사용자의 전역 gitignore
설정에 의존**하고 있었다 — 설정이 없으면 오히려 스캐폴드를 막았다. basename 화이트리스트는
사용자 git 설정과 무관하게 결정적이다.

### R-6 — sanitizer가 nullish throw에서 프로세스를 죽였다 (medium)
게이트 지적: worker의 catch가 타입 단언 후 곧바로 구조분해해, `throw null`·`throw undefined`·
빈 `Promise.reject()`에서 **catch 안에서 다시 throw**하며 프로세스가 죽었다 — **예외 격리를 하려고
넣은 try/catch가 오히려 죽이는** 상황(I-1이 막으려던 바로 그것).

실 컨테이너(distroless) 6초 관찰:

| throw 형태 | BEFORE | AFTER |
|---|---|---|
| `throw null` | **Running=false, exit 1** (`TypeError: Cannot destructure...`) | Running=true, `tick failed (code=none): null` ×7 |
| `throw undefined` | **Running=false, exit 1** | Running=true, `tick failed (code=none): undefined` ×7 |
| `await Promise.reject()` | **Running=false, exit 1** | Running=true, 동일 |
| `throw "just a string"` | Running=true | Running=true, `tick failed (code=none): just a string` |
| Error + sentinel 크리덴셜 | Running=true, 미유출 | Running=true, `tick failed (code=X1): Error: boom`, **SENTINEL_pw 미유출** |

**PASS** — 5개 형태 중 **BEFORE에서 3개가 컨테이너를 죽였다**. AFTER는 전부 생존하고 1s 백오프로
재시도하며(6초에 7줄), 객체는 절대 펼치지 않아 크리덴셜이 새지 않는다(`db.ts`와 동일 규율).

### 실제 CI 재실행 (R-5/R-6 수정 반영)
**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29197329127
**SHA**: `6a801be` · 5개 잡 전부 **pass**
(scaffold-build fullstack/api/site/worker + scaffold-args)

## 12. release 게이트 r3 수정의 검증 (R-7)

r3 게이트: **sanitizer가 에러를 조사하는 도중에 여전히 throw할 수 있다.** `code`·`stack`·`message`를
직접 읽는 것이 **임의의 getter나 Proxy trap을 호출**하고, 그것이 catch 안에서 던지면 백오프를
건너뛰고 프로세스가 죽는다 — **예외 격리를 위해 넣은 try/catch가 오히려 죽이는** 마지막 경로.

실 컨테이너(distroless), 6~7초 관찰:

| throw된 값 | BEFORE | AFTER |
|---|---|---|
| `code`가 throw하는 getter | **Running=false, exit 1** (`getter blew up`) | Running=true, `tick failed (code=none): Error: boom` + stack |
| 해지된 Proxy | **Running=false, exit 1** | Running=true, `(읽을 수 있는 message·stack 없음)` |
| `message` getter가 throw | **Running=false, exit 1** | Running=true, 동일 |
| 함수형 exotic + throw하는 `toPrimitive` | **Running=false, exit 1** | Running=true, `(읽을 수 없는 throw 값)` (상수 폴백 — 죽은 코드가 아님) |
| 기존 케이스(null/undefined/reject/문자열/sentinel Error) | 회귀 없음 | 전부 생존, **SENTINEL_pw 미유출** |

**PASS** — 필드별 try/catch + 상수 폴백을 가진 **비-throw 포매터**로 모든 프로퍼티 접근·강제 변환을
가뒀다. 객체는 여전히 절대 펼치지 않는다(펼치면 첨부 크리덴셜이 샌다 — R-4).

### 같은 결함 클래스를 db.ts에도 적용
`api/src/db.ts`의 pool error 리스너가 **정확히 같은 취약 패턴**(타입 단언 후 직접 읽기)을 갖고 있었다.
pg가 진짜 Error만 emit해 실증 위험은 낮았으나 같은 클래스이므로 규율을 맞췄다.

```
RED  (수정 전): code가 throw하는 getter를 주입 풀에 emit
     → 예외가 emit 스택을 뚫고 프로세스 종료 (exit=1, "SURVIVED" 미도달)
GREEN(수정 후): pg pool error (code=none): Error: terminating connection due to administrator command
     → SURVIVED, exit=0, 14 pass
```
유출 가드 회귀 테스트도 **강화**했다(약화 아님): 기존엔 `typeof line === "string"`만 봤는데, pg가
실제로 하는 대로 `client: { password: "SENTINEL_pw" }`를 매단 에러로 sentinel 부재를 **직접** 고정한다.
P-6 구조 가드도 유지(리스너 등록을 `createPool`로 옮기면 이제 **3개** 테스트가 실패). api 13 → **14 tests**.

실 Postgres 재확인: `pg_terminate_backend` → `pg pool error (code=57P01)` 로깅, 컨테이너 생존
(restarts=0), `/healthz` 200 / `/readyz` 503 → DB 복구 → `/readyz` 200. 로그에 sentinel 0회.

### 실제 CI 재실행 (R-7 반영)
**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29200462009
**SHA**: `60e0ec9` · 5개 잡 전부 **pass**

---

## 검증하지 못한 것 (정직한 공백)

- **homelab 클러스터 배포**: 실제 k3s 배포·차트 연동은 이 레포 밖이다. 차트가 소비하는
  `.app-config.yml`의 스키마 적합성은 template-ci가 homelab 스키마(@main)로 검증한다(CI에서 통과).
- **Renovate 실제 PR 생성**: dry-run으로 브랜치/파일 집합을 확인했으나, 실제 GitHub에서의 토큰
  권한·PR 생성은 F-1(레포 등록) 이후에만 관측 가능하다.
- **사용자 파일 보호 가드는 git 저장소에서만 동작**한다(귀속 기준이 최초 커밋 트리이므로). ZIP으로
  받아 쓰는 경로와 `rm -rf .git` 사본(template-ci가 쓰는 경로)은 여전히 구멍이며, 템플릿 문서를
  같은 경로에서 **수정만** 한 경우도 구분되지 않는다. 이 사실은 코드 주석에만 있고 사용자에게
  보이는 경고는 없다.
