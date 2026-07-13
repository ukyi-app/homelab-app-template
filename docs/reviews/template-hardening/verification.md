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

## 13. release 게이트 r4 → 접근법 전환 (R-8)

r4 게이트: **함수형 값이 비-확장 sanitizer를 우회한다.** 원시값 분기가 함수를 포함하므로
(`typeof fn === "function"`), `client.password`를 달고 **던지지 않는** `Symbol.toPrimitive`를 가진
callable이 `String(e)`를 타고 **그 비밀번호를 로그에 실었다**. 이는 **R-7 수정이 만든 회귀**다 —
크래시를 막으려 넣은 폴백이 유출을 열었다.

### 사람의 판단: 코드가 아니라 접근법이 틀렸다
게이트가 **네 라운드 연속 같은 결함 클래스**를 한 겹씩 벗겨냈다(R-4 객체 덤프 → R-6 nullish →
R-7 던지는 accessor → R-8 callable 우회). 매 수정이 "방금 증명된 위험"만 막는 **블록리스트**였고,
매번 다음 구멍이 열렸다. 그래서 포매터를 **allowlist-only로 재설계**했다.

- 허용 필드(`code`/`message`/`stack`)를 가드된 읽기로 읽되 **`typeof`가 `string`일 때만** 채택
- 값 자체는 **진짜 원시값**(string/number/boolean/bigint)일 때만 — 그 외에는 값이 아니라 **타입 이름**
- `String()`·`toString`·`Symbol.toPrimitive`·`unknown` 보간이 **코드에 하나도 없다**

남의 코드가 실행될 통로 셋(콘솔의 객체 펼침 / 강제 변환 훅 / 프로퍼티 읽기)이 전부 닫혔다.

### 적대적 배터리 16종 (worker=실 컨테이너, db=bun test) — BEFORE 13/16 → AFTER **16/16**

| 케이스 | BEFORE | AFTER |
|---|---|---|
| callable + password + non-throwing `Symbol.toPrimitive` (R-8 repro) | **훅 실행됨** — `harmless-looking` 로깅 | `(...: function)`, 훅 실행 **false** |
| 〃, 훅이 password를 반환 | **`leaked:SENTINEL_pw` 평문 유출** | `(...: function)`, grep 0 |
| callable + password + non-throwing `toString` | **`leaked:SENTINEL_pw` 유출** | `(...: function)`, grep 0 |
| 해지된 **함수** Proxy | `String()`이 던져 최후 catch로 떨어짐 | `(...: function)` — **아무것도 던지지 않음** |
| Error+password / 던지는 getter / 해지 Proxy / null / undefined / reject / 문자열 / Symbol / BigInt / null-proto | 기존대로 | 전부 생존, 문자열 throw는 문자열 그대로 |

**PASS** — AFTER 전 케이스에서 **훅 실행 0회**(결과를 검사하는 게 아니라 **호출 자체를 플래그로 금지**),
`SENTINEL` grep 0건, `console.error` 인자 타입 100% `string`, Running=true, 1s 백오프 지속.

api 테스트 **14 → 16**: 콜러블 센티넬 케이스 + **12행 타입 표**(모양이 아니라 규율을 고정 — 콜러블
하나만 테스트하면 그것도 결국 점-테스트라 클래스 회귀를 못 막는다).

### 실제 CI 재실행
**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29201410004
**SHA**: `5322d06` · 5개 잡 전부 **pass** (api 이미지 게이트 안에서 16 pass 확인)

## 14. release 게이트 r5 → 읽기 규율까지 닫음 (R-9, 클래스 종결)

r5 게이트: **allowlist된 읽기가 여전히 callable accessor를 실행한다.** `field()`가 `e[key]`를
평가하고, 가드는 **던지는** accessor만 잡으며 **성공한 getter의 반환값은 신뢰**한다. `client.password`를
달고 `get message() { return this.client.password }`를 가진 callable이 그 password를 로깅했다 —
**재설계가 만든 회귀**(강제 변환 훅을 accessor 훅으로 바꿨을 뿐).

핵심 진단: allowlist는 "**어떤 값**을 쓸지"만 제한했고 "**어떻게 읽을지**"는 제한하지 않았다.

### 마지막 통로를 닫는다 — descriptor-only
- 객체가 아니면(함수·심볼·원시값) **필드 읽기 전에** 타입 라벨로 낙하
- 읽을 때는 `Object.getOwnPropertyDescriptor` + **`Object.hasOwn(d, "value")`**로 **own 데이터
  서술자일 때만** 값을 채택 — **accessor는 호출하지 않고 거절**
- `"value" in desc`가 **아니라** `Object.hasOwn`을 쓴 이유(구현자가 실측으로 발견): 서술자의
  프로토타입은 `Object.prototype`이라, 누가 `Object.prototype.value`에 getter를 심으면 `in` 검사가
  accessor 서술자를 통과시키고 뒤이은 `d.value`가 **그 상속 getter를 호출한다** — 결함 클래스가
  프로토타입 오염이라는 뒷문으로 재유입된다.

**Bun 실측**: native Error의 `message`·`stack`·`code`는 **전부 own 데이터**(V8과 달리 stack이
accessor가 아니다) → 진단을 잃지 않는다. 프로토타입 accessor로 `code`를 노출하는 커스텀 에러
클래스만 `code=none`으로 떨어지는데, 선의의 accessor와 악의의 accessor는 구분할 수 없으므로
의도된 트레이드다.

### 남아 있는 "남의 코드 실행" 통로 — 전수 열거
포맷팅 중 실행되는 연산: `typeof` / `=== null` / **원시값만** 보간 / `getOwnPropertyDescriptor` /
`hasOwn` / own 데이터 GET / 문자열 연결 / `console.error(string)`.
남의 코드가 돌 수 있는 곳은 **Proxy의 `getOwnPropertyDescriptor` trap 하나뿐**이고, try/catch로
감싸여 있으며, 그 trap이 데이터 서술자로 돌려주는 문자열은 **앱이 직접 빚어 "이게 message다"라고
건넨 데이터** — "앱이 스스로 message에 비밀을 넣었다"와 같은 정책 경계다.
(정직한 예외: 앱이 `Object.getOwnPropertyDescriptor` 자체를 갈아치우는 렐름 변조. 유저랜드 JS로
방어 불가. 현실적으로 잦은 수동적 형태인 **프로토타입 오염은 위 `hasOwn` 선택으로 닫혔다**.)

### 적대적 배터리 — worker 25종 / db 26종
**BEFORE: worker 5 FAIL, db 5 FAIL → AFTER: 0 FAIL / 0 FAIL.**

| 케이스 | BEFORE | AFTER |
|---|---|---|
| callable + password + **성공하는** `get message()` (R-9 repro) | **LEAK** `SENTINEL_pw`, 훅 실행됨 | `(...: function)`, **훅 0회** |
| 객체 + 성공하는 `get message()` | **LEAK** | `(...: object)`, 훅 0회 |
| 성공하는 `get code()` / `get stack()` | **LEAK** | 훅 0회 |
| 살아있는 Proxy `get` trap | **LEAK ×2** | 훅 0회 |
| native Error(진단 보존) | PASS | `Error: plain native failure` / `(code=ECONNRESET)` |
| 기존 전 케이스(던지는 getter·해지 Proxy·훅·nullish·원시값·null-proto) | PASS | PASS |

AFTER 전 케이스: Running=true, 백오프 1.00~1.01s 지속, `console.error` 인자 = **문자열 1개**,
SENTINEL 0건, 훅 0회.

### 같은 클래스의 마지막 인스턴스 — `/readyz` 핸들러
`e instanceof Error ? e.message : String(e)` — 평범한 GET(accessor 실행 가능) + `String()`(훅 실행).
**싱크가 HTTP 503 본문이라 로그보다 더 위험하다**(파드에 닿는 누구나 읽고 k8s 이벤트가 퍼 나른다).
같은 규율로 닫았다. 본문 정책: **code + message는 싣고 stack은 뺀다**(로그에는 stack 유지).

RED→GREEN: 취약 코드에서 `not ready: SENTINEL_pw`(본문 유출) + 훅 실행 + 던지는 getter가 핸들러를
뚫어 500 → 수정 후 22 pass. **구현자가 자기 가짜 GREEN을 잡아냈다**: 처음엔 plain object로
sentinel을 심었는데 옛 코드는 `instanceof Error`일 때만 `.message`를 읽어 우연히 안전했다 —
pg가 reject하는 건 **Error**이므로 Error 인스턴스로 심어야 실제 채널을 겨냥한다.

실 Postgres: DB 정지 → `/readyz` 503 `not ready (code=none): Connection terminated...`, `/healthz`
200 유지, restarts=0 → DB 복구 → 200. 잘못된 password로 붙이면 `(code=28P01): password
authentication failed` — 진단은 살아 있고 password는 나가지 않는다(로그·본문 SENTINEL 0건).

읽기 규율 구현은 **아키타입 안에서 하나뿐**(db.ts가 export). 뮤테이션으로 확인: 공유 헬퍼를
`e[key]`로 되돌리면 **두 싱크가 동시에 깨진다**. api 테스트 16 → **22**.

### 실제 CI 재실행
**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29216623881
**SHA**: `12d8716` · 5개 잡 전부 **pass**

## 15. F-8 — ownString 정합 가드 (복제된 읽기 규율의 드리프트 방어)

§14까지 읽기 규율(`ownString` — own 데이터 서술자만 채택, accessor·Proxy 트랩·문자열화 훅 미호출)은
worker(`src/index.ts`)와 api(`src/db.ts`)에 **두 벌** 복제돼 있고(아키타입 간 공유 모듈 금지 = 의도, 앱엔
하나만 복사되므로), 방어선은 **각 아키타입의 타입-표 테스트**뿐이었다. 두 표가 어긋나도 잡는 장치가 없었다 —
F-7에서 실제로 api 표만 뒤처져 own 데이터 비문자열(`{message:{toString:()=>password}}`)·`Object.prototype`
오염 케이스가 빠졌고, 그 유출은 로그보다 노출이 큰 **HTTP 503 본문**으로 나갔다.

template-ci(`scaffold-args`)에 **본문 동일성 가드**를 배선했다: `scaffold/archetypes/*/src/*.ts`에서
ownString 정의를 **발견**(열거 아님 — 새 아키타입이 DB를 얻어 복제하면 자동 편입)해 각 본문을 추출(CRLF
선제거 → `export` 정규화)·해시하고 **바이트 동일성**을 강제한다.

**왜 '표 대조'가 아니라 '본문 동일성'인가**: api는 sink가 둘(로그 + `/readyz` 503 본문)이라 테스트 표가
정당하게 다르다(describe 이름부터). 표의 케이스 집합을 대조하면 그 정당한 차이를 오탐하거나, 오탐을 피하려
헐거워져 **뮤테이션으로 RED를 못 박는다**(이 레포가 받지 않는 가드). 대신 '표가 겨누는 코드'를 하나로 묶는다 —
본문을 강제 동일화하면 두 복제본은 사실상 한 벌이 되고, worker의 포괄 표(25행)가 양쪽을 보증한다. sink별로
다른 포매터(`errLine`/`notReadyBody`)는 공유 단위가 아니라(프리픽스·stack 적재가 정당하게 다르다) 각자 자기
표로 지키므로 여기서 비교하지 않는다.

### RED 증명 — 가드가 무는가 (로컬 실측, `LANG=en_US.UTF-8 bash`)
| 뮤테이션 | 기대 | 실측 |
|---|---|---|
| worker `hasOwn(d,"value")` → `"value" in d` (F-7의 그 구멍, 한쪽) | RED "본문이 갈라졌다" | RED ✅ |
| api `typeof v==="string"?v:undefined` → `v as string` (문자열 검사 제거, 한쪽) | RED "본문이 갈라졌다" | RED ✅ |
| worker 본문에 공백 한 칸 (바이트 드리프트) | RED "본문이 갈라졌다" | RED ✅ |
| ownString 이름 변경 → 발견 1개 (fail-closed) | RED "정의를 1개만 찾았다" | RED ✅ |
| 양쪽 `};` → bare `}` (추출 overrun) | RED "**추출이 어긋났다**"(오진 아님) | RED ✅ |

마지막 행이 핵심 — 닫는 `};`가 드리프트해 추출이 다음 함수(`errLine`)까지 넘치면, '본문이 갈라졌다'로
**오진하지 않고** '추출이 어긋났다(화살표블록 2개[기대 1])'로 정직하게 지목한다. CRLF로 커밋된 파일은
`tr -d '\r'` 선제거로 정상 GREEN이다(앵커 `^};$`가 `};\r`에 빗나가 파일을 통째로 삼키던 병리 제거).

### 전이 보증 — 양쪽을 똑같이 약화하면 표가 잡는다
가드는 **드리프트**(한쪽만 변경)만 본다. 양쪽을 동일하게 약화하면(문자열 검사를 둘 다 제거) 가드는 정당하게
GREEN이지만 — 두 복제본이 이제 한 벌이므로 — **worker의 bun test 표가 RED**다. 실측: 동일 약화 → 가드
exit 0, `bun test worker` **8 pass / 1 fail**(`hookRan` 위반). 한쪽 변경은 가드가, 양쪽 동일 변경은
표가(Dockerfile 게이트의 `RUN bun run test`) 잡는다 — 두 관문이 상보적으로 클래스를 닫는다.

### 적대적 리뷰 (11 에이전트, 3 렌즈)
false-green 헌터 / 이식성·플레이크 / F-8 실효성 세 렌즈로 공격 → 8건 중 7건 refute, 1건(minor) 반영:
발화 불가한 `n_hash` 핀이 주석으로 "삼킴 병리를 개수로 잡는다"고 **과장**하던 것을 제거하고 실효 있는
**추출 무결성 검사**(화살표블록 1개 + 마지막 줄 `};`)로 교체, CRLF 선제거, 에러 메시지가 파일을 가리키도록
`${f}` 명시(byte-지향 로케일에서 변수 뒤 한글 첫 바이트가 변수명에 삼켜져 파일명이 사라지던 것). actionlint
(shellcheck 포함) 통과. YAML에서 `run` 스크립트를 파싱·추출해 그대로 실행, GREEN/overrun-RED/drift-RED 재확인.

### 실제 CI 재실행
**Run**: https://github.com/ukyi-app/homelab-app-template/actions/runs/29242032212 (PR #20)
**SHA**: `107c2ee` · 5개 잡 전부 **pass** — `scaffold-args`의 ownString 가드가 15s에 pass하고
러너 로그에 `✅ ownString 본문 정합: 2곳(...) 동일(12a9f56f...)`를 남겼다(발견 2개, 로컬과 동일 해시).

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
- **⚠️ 에러 포매터의 Proxy 잔여 (release 게이트 r6가 지적, 사람이 waive — F-6)**: 살아있는 Proxy의
  `getOwnPropertyDescriptor` trap이 **첨부된 크리덴셜을 `message`인 척 own 데이터 서술자로 합성해**
  반환하면 현재 헬퍼가 수용해 로깅한다. "trap이 돌려주는 건 앱이 스스로 빚은 데이터뿐"이라는 정리는
  **부정확했다**. 다만 JS에서 임의 값의 프로퍼티를 trap 없이 읽는 방법이 없고(gOPD·Reflect.ownKeys·
  toStringTag 전부 trap 대상, Proxy 판별 불가), 완전 차단은 "객체는 타입만 로깅" = 진단 소멸을 뜻한다.
  **재현된 실제 위협(pg가 선의로 password를 진짜 Error에 첨부하는 수동적 유출)은 완전히 닫혔고**,
  적대적 Proxy는 공격자 코드가 이미 in-process여야 성립하므로 포매터의 방어 경계 밖이다.
- **release 게이트 r6는 형식적 판정을 내지 못했다** — 여섯 번 시도(전체 diff/focus 축소/base 축소/
  timeout 3600s) 모두 `codexStatus: 1`로 중단. `--selftest` 정상, 작은 레포에서 같은 루브릭이 정상
  완주하므로 엔진·인증 문제가 아니라 이 브랜치 리뷰에 특정된 장애다. 반환된 `approve`/`findings: []`는
  **승인이 아니라 리뷰 미수행**이며 그렇게 취급하지 않았다(하드 룰 2). r1~r5의 지적 9건(R-1~R-9)은
  전부 수정·검증됐고 실제 CI가 green이다.
- **에러 포매터의 그 밖의 잔여 위험**(allowlist-only 재설계 후에도):
  ① `message`/`stack`이 **문자열이면 그대로 찍는다** — 앱이 스스로 비밀을 message에 넣으면 나간다
  (포매터가 아니라 정책 문제). ② getter의 **부작용**(네트워크·파일)은 여전히 실행된다 — 던지는 것은
  잡지만 부작용은 못 막는다(완전 차단은 Proxy 트랩 때문에 불가능하면서 진단만 잃는 교환이라 하지 않음).
  ③ 규율을 **타입체커가 강제하지 못한다** — 포크한 사람이 `String()`을 다시 넣으면 클래스가 다시
  열린다. 방어선은 **각 아키타입의 타입-표 테스트**(worker 25행·api 26행, SENTINEL grep — Dockerfile
  게이트의 `RUN bun run test`가 강제)와 **F-8의 `ownString` 정합 가드**(§15)다.
  ④ 다만 F-8 가드는 **공유 읽기 규율(`ownString`)**의 드리프트만 본다 — sink별 포매터(`errLine`/
  `notReadyBody`)의 타입-게이트·프리픽스가 **한 아키타입에서만** 회귀하면 그건 그 아키타입 자신의 표만이
  잡는다(worker는 F-7로 표가 생겨 더는 무방비가 아니고, api는 R-9부터 표가 있다).
