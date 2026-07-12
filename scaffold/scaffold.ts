#!/usr/bin/env bun
// 대화형 스캐폴더 — 아키타입(fullstack/api/site/worker)을 선택해 즉시 배포 가능한 앱을 생성한다.
// pnpm create vite 류 UX. 실행 후 자기 자신을 삭제한다(앱 레포에 스캐폴드 머신러리 미잔존).
import { intro, outro, select, text, confirm, isCancel, cancel } from "@clack/prompts";
import { stringify as toYaml } from "yaml";
import { cpSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const SCAFFOLD = join(ROOT, "scaffold");
if (!existsSync(SCAFFOLD)) { console.error("scaffold/ 부재 — 이미 스캐폴드된 레포로 보임"); process.exit(1); }
if (existsSync(join(ROOT, "src")) || existsSync(join(ROOT, "web"))) {
  console.error("src/ 또는 web/ 이미 존재 — 중복 스캐폴드 방지(부분 생성이면 정리 후 재실행)"); process.exit(1);
}

// --- 인자 (strict: allowlist 외 flag·누락/flag-형 값 거부 — homelab parseFlags fail-closed 규약 모사) ---
const argv = process.argv.slice(2);
const ARCHES = ["fullstack", "api", "site", "worker"] as const;
type Arch = (typeof ARCHES)[number];
const KIND: Record<Arch, "web" | "site" | "worker"> = { fullstack: "web", api: "web", site: "site", worker: "worker" };
type Kind = (typeof KIND)[Arch];
// kind별 능력표 — 경고·프롬프트·.app-config 조립이 전부 이 표 하나만 읽는다(같은 지식을 여러 곳에 복제하면 어긋난다).
const CAP: Record<Kind, { route: boolean; metrics: boolean; probes: boolean }> = {
  web: { route: true, metrics: true, probes: true },
  site: { route: true, metrics: false, probes: false },
  worker: { route: false, metrics: false, probes: false },
};
// DB가 없는 아키타입(fullstack·site·worker — pg도 src/db.ts도 api에만 있다)이 공유하는 문구.
// 없는 파일을 가리키는 문서를 앱에 심지 않으려고 DOC로 뺐다.
const NO_DB_SECRET = "로컬에서만 쓰는 값(개발용 URL·토큰)은 `.env`가 아니라 `.env.local`에 둔다 — 봉인 대상이 아니다. 이 아키타입엔 DB가 없다(DB를 붙일 때의 접속 URL 규약은 `.env.example` 주석에).";
const NO_DB_ENV = [
  "# --- 규약 3) 이 앱엔 DB가 없다 ---",
  "# 이 아키타입은 DB에 붙지 않는다(pg 의존도, 접속 코드도 없다). 나중에 붙이더라도 접속 URL은 .env에 넣지 않는다 —",
  "# 프로덕션 URL은 homelab provision-db가 conn SealedSecret으로 만들어 <APP>_DATABASE_URL로 파드에 주입하고,",
  "# 로컬 URL은 규약 2대로 .env.local에 둔다.",
];
// 아키타입별 문서 문구 — 런타임·개발 명령·비밀 값 규약은 아키타입마다 사실이 다르다(worker는 HTTP를 서빙하지 않고,
// site는 distroless가 아니라 정적 서버 이미지이며, DB는 api에만 있다). 한 줄로 뭉뚱그리면 4분의 3이 거짓말이 된다.
// cmds·gates가 package.partial.json·Dockerfile과 어긋나면 아래 가드가 스캐폴드를 죽인다(주석으로 부탁하지 않는다).
const DOC: Record<Arch, { runtime: string; gates: string[]; cmds: string[]; note: string[]; secret: string; env: string[] }> = {
  fullstack: {
    runtime: "arm64 distroless non-root — 하나의 Hono 프로세스가 API와 빌드된 SPA(`web/dist`)를 http `:8080`으로 서빙한다. metrics `:9090`은 `.app-config.yml`에 `metrics.enabled=true`일 때만 수집된다.",
    gates: ["typecheck", "test", "build"],
    cmds: [
      "bun run dev        # 서버(:8080) + 웹 dev 서버(:5173) 동시 기동",
      "bun run build      # web/dist(vite) + 단일 바이너리 app",
      "bun run typecheck",
      "bun run test",
    ],
    note: [
      "`dev`는 두 프로세스를 한 번에 띄운다(`concurrently`) — 로그 접두어 `[server]` = Hono(`src/index.ts`, :8080),",
      "`[web]` = vite dev 서버(:5173). **브라우저는 :5173으로 연다** — vite가 `/api/*`를 :8080의 Hono로 프록시하므로",
      "(`vite.config.ts`의 `server.proxy`) 웹은 HMR을 받으면서 진짜 API를 호출한다.",
      "프로덕션엔 vite가 없다 — 같은 Hono가 `web/dist`를 직접 서빙한다(그래서 포트가 하나뿐이다).",
      "한쪽이 죽으면 다른 쪽도 함께 내려간다(`--kill-others`) — 반쪽만 살아남아 헷갈리는 상태가 없다.",
    ],
    secret: NO_DB_SECRET,
    env: NO_DB_ENV,
  },
  api: {
    runtime: "arm64 distroless non-root — Hono가 http `:8080`. metrics `:9090`은 `.app-config.yml`에 `metrics.enabled=true`일 때만 수집된다.",
    gates: ["typecheck", "test", "build"],
    cmds: [
      "bun run dev        # Hono :8080 (--watch 리로드)",
      "bun run build      # 단일 바이너리 app",
      "bun run typecheck",
      "bun run test",
    ],
    note: [
      "차트가 찌르는 probe는 `/healthz`(정적) · `/readyz`(DB가 있으면 왕복 확인) 둘이다.",
      "DB URL은 앱 이름을 몰라도 되도록 env 접미사로 자동 발견한다(`src/db.ts`) — 규약은 `.env.example` 주석에.",
    ],
    secret: "DB 접속 URL은 `.env`에 넣지 않는다 — `.env`는 통째로 봉인되어 프로덕션까지 따라가고, 거기서 플랫폼이 주입한 URL을 가린다(`src/db.ts`는 generic `DATABASE_URL`을 먼저 본다). 프로덕션 URL은 homelab이 별도 SealedSecret으로 주입하고, 로컬 URL은 `.env.local`에 둔다 — 규약은 `.env.example` 주석에.",
    env: [
      "# --- 규약 3) DB 접속 URL은 .env에 넣지 않는다 ---",
      "# 프로덕션: homelab provision-db가 conn SealedSecret을 따로 만들어 파드에 주입한다.",
      "#   <APP>_DATABASE_URL          런타임(앱 롤, 풀러 경유)",
      "#   <APP>_MIGRATE_DATABASE_URL  마이그레이션 전용",
      "#   <APP>_RO_DATABASE_URL       읽기 전용",
      "#   (<APP> = 앱 이름의 UPPER_SNAKE — my-shop → MY_SHOP_DATABASE_URL)",
      "# 로컬: homelab의 db-url 도구가 .env.local에 URL을 쓴다(규약 2 — 봉인 대상이 아니다).",
      "#",
      "# src/db.ts는 앱 이름을 몰라도 되도록 접미사 _DATABASE_URL로 URL을 찾고,",
      "# _MIGRATE_/_RO_ 키는 런타임 후보에서 제외한다.",
      "# ★현재 우선순위: 접두사 없는 generic DATABASE_URL이 있으면 그게 무조건 이긴다(접미사 매칭은 그게",
      "#   없을 때만 돈다). 그래서 DB URL을 .env에 적으면 봉인되어 프로덕션까지 따라가 <APP>_DATABASE_URL을",
      "#   가린다 — 로컬 개발 URL은 .env가 아니라 .env.local에.",
    ],
  },
  site: {
    runtime: "arm64 static-web-server 이미지(scratch 기반 — **distroless가 아니다**). 앱 코드는 돌지 않고 `web/dist` 정적 산출물만 서빙한다. 서버 인자는 homelab 차트가 주입한다(목록은 `Dockerfile` 주석) — http는 `:8080`이고, non-root는 파드 securityContext가 강제한다. metrics 없음.",
    gates: ["typecheck", "build"],
    cmds: [
      "bun run dev        # vite dev 서버 :5173 (HMR)",
      "bun run build      # web/dist 정적 산출물",
      "bun run typecheck",
    ],
    note: [
      "정적 SPA다 — 앱 코드가 도는 서버 프로세스가 없다. 이 이미지의 Dockerfile 게이트는 `typecheck`·`build` 둘뿐이라",
      "`test` 스크립트를 추가해도 이미지 빌드가 강제하지 않는다 — 강제하려면 Dockerfile에 `RUN bun run test`를 함께 넣는다.",
    ],
    secret: NO_DB_SECRET,
    env: NO_DB_ENV,
  },
  worker: {
    runtime: "arm64 distroless non-root — **HTTP를 서빙하지 않는다**(포트·route·probe 없음). SIGTERM을 받으면 진행 중인 주기를 접고 스스로 종료한다.",
    gates: ["typecheck", "build"],
    cmds: [
      "bun run dev        # 워커 루프 (--watch 리로드)",
      "bun run build      # 단일 바이너리 app",
      "bun run typecheck",
    ],
    note: [
      "HTTP가 없으니 확인은 stdout 로그(`tick ...`)로 한다. Ctrl-C(SIGINT)에 바로 멈추는지도 여기서 본다 —",
      "클러스터가 주는 유예시간 안에 스스로 끝나지 못하면 SIGKILL(exit 137)이다(유예시간 값은 homelab 차트가 정한다).",
    ],
    secret: NO_DB_SECRET,
    env: NO_DB_ENV,
  },
};
const BOOL = new Set(["--public", "--metrics", "--no-autodeploy", "--yes"]);
const VAL = new Set(["--archetype", "--name"]);
const ALLOWED = "--archetype --name --public --metrics --no-autodeploy --yes";
const flags: Record<string, string | boolean> = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (BOOL.has(a)) flags[a] = true;
  else if (VAL.has(a)) {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) { console.error(`${a}: 값 필요`); process.exit(2); }
    flags[a] = v;
  } else { console.error(`알 수 없는 옵션: '${a}' (허용: ${ALLOWED})`); process.exit(2); }
}
const NONINT = flags["--yes"] === true || !process.stdin.isTTY;
// homelab tools/lib/identity.ts의 APP_NAME_RE와 동일(소문자 시작·trailing hyphen 금지·길이 2..40).
const NAME_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;
const validName = (n: string): string => {
  if (!NAME_RE.test(n)) { console.error(`앱 이름 불량(소문자 시작, 소문자/숫자/하이픈, trailing hyphen 금지, 2..40자): '${n}'`); process.exit(2); }
  return n;
};
const warn = (m: string) => console.error(`⚠️  ${m}`);

// 유일한 필수 의존은 bun이다 — git 미설치 시 Bun.spawnSync는 비0을 반환하는 게 아니라 throw하므로 반드시 감싼다.
// 모든 실패(git 부재·레포 아님·git 오류)를 null로 접어 호출부가 fallback 하나로 처리하게 한다.
const git = (...args: string[]): string | null => {
  try {
    const r = Bun.spawnSync(["git", "-C", ROOT, ...args], { stdout: "pipe", stderr: "pipe" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch { return null; }
};
const realpath = (p: string): string => { try { return realpathSync(p); } catch { return p; } };

// 배포 식별자는 GitHub 레포명이다(ADR-0002) — 이름 기본값을 origin URL에서 유도한다.
// git 부재·git 레포 아님(CI의 `rm -rf .git` 사본)·origin 부재(fresh git init) → 전부 디렉토리명 fallback.
const deriveName = (): string => {
  const dir = basename(ROOT);
  // git은 상위로 거슬러 올라간다 — 남의 레포 하위에서 스캐폴드하면 부모의 origin이 잡혀 엉뚱한 이름이 조용히 박힌다.
  // toplevel이 ROOT 자신일 때만 origin을 채택한다(심볼릭 링크 때문에 realpath로 비교).
  const top = git("rev-parse", "--show-toplevel");
  if (!top || realpath(top) !== realpath(ROOT)) return dir;
  const origin = git("remote", "get-url", "origin");
  if (!origin) return dir;
  // SSH(git@host:owner/repo.git)·HTTPS(https://host/owner/repo) 공통 — 마지막 경로 세그먼트가 레포명.
  const repo = origin.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop() ?? "";
  // 레포명이 NAME_RE를 어기면 그 레포명은 배포 식별자가 될 수 없다(create-app이 리젝) — 조용히 넘기지 않는다.
  if (!NAME_RE.test(repo)) {
    warn(`origin 레포명 '${repo}'은(는) 앱 이름 규칙(소문자 시작, 소문자/숫자/하이픈, trailing hyphen 금지, 2..40자)을 어겨 배포 식별자로 쓸 수 없다 — 디렉토리명 '${dir}'을 기본값으로 쓴다(배포하려면 GitHub 레포명 자체를 규칙에 맞게 고쳐야 한다).`);
    return dir;
  }
  return repo;
};
const derived = deriveName();

async function ask(): Promise<{ archetype: Arch; name: string; pub: boolean; metrics: boolean; autoDeploy: boolean }> {
  if (NONINT) {
    const a = ((flags["--archetype"] as string) ?? "fullstack") as Arch;
    if (!ARCHES.includes(a)) { console.error(`--archetype은 ${ARCHES.join("|")} 중 하나`); process.exit(2); }
    const k = KIND[a];
    const pub = flags["--public"] === true;
    const metrics = flags["--metrics"] === true;
    // 인식된 플래그가 선택한 kind와 무관하면 조용히 드롭하지 않고 경고한다(실제 무시는 아래 cfg 조립이 CAP로 한다 —
    // 여기서 값을 한 번 더 꺾으면 같은 지식의 사본이 늘 뿐이다). 알 수 없는 플래그는 위 파서에서 exit 2 — 오타와 의도는 다르게 다룬다.
    if (pub && !CAP[k].route) warn(`--public 무시: kind=${k}는 서빙하지 않아 route가 없다`);
    if (metrics && !CAP[k].metrics) warn(`--metrics 무시: kind=${k}는 metrics(:9090)를 노출하지 않는다`);
    return { archetype: a, name: validName((flags["--name"] as string) ?? derived), pub, metrics, autoDeploy: flags["--no-autodeploy"] !== true };
  }
  intro("homelab 앱 스캐폴드");
  const ARCH_OPTIONS: { value: Arch; label: string }[] = [
    { value: "fullstack", label: "🌐 Full-stack (Hono + React)" },
    { value: "api", label: "🔌 API (Hono)" },
    { value: "site", label: "📄 Static site (React SPA)" },
    { value: "worker", label: "⚙️ Worker (백그라운드)" },
  ];
  const archetype = (await select({ message: "아키타입", options: ARCH_OPTIONS, initialValue: "fullstack" })) as Arch;
  if (isCancel(archetype)) { cancel("취소"); process.exit(0); }
  const name = (await text({ message: "앱 이름", initialValue: derived, validate: (v) => (NAME_RE.test(v) ? undefined : "소문자 시작·소문자/숫자/하이픈·trailing hyphen 금지·2..40자") })) as string;
  if (isCancel(name)) { cancel("취소"); process.exit(0); }
  const cap = CAP[KIND[archetype]];
  const pub = cap.route ? ((await confirm({ message: "공개 노출(ukyi.app)? (아니오=home.ukyi.app 내부)", initialValue: false })) as boolean) : false;
  const metrics = cap.metrics ? ((await confirm({ message: "metrics(:9090) 활성?", initialValue: false })) as boolean) : false;
  const autoDeploy = (await confirm({ message: "autoDeploy?", initialValue: true })) as boolean;
  return { archetype, name, pub, metrics, autoDeploy };
}

const { archetype, name, pub, metrics, autoDeploy } = await ask();
const kind = KIND[archetype];
const doc = DOC[archetype];

// 배포 식별자는 레포명 하나에서 파생된다(ADR-0002) — 유도값과 다른 이름은 경고만 한다.
// 하드 강제는 homelab create-app이 하고, CI가 임시 디렉토리에서 `--name ci-<archetype>`으로
// 스캐폴드하는 정당한 사용처가 있어 여기서 실패시키면 안 된다.
if (name !== derived) warn(`앱 이름 '${name}'이(가) 유도값 '${derived}'와 다르다 — 이 값은 배포 식별자가 아니며 GitHub 레포명과 같아야 한다(create-app이 repoName === app을 강제).`);

// --- 롤백: 전개 前 루트 엔트리 스냅샷 → 실패 시 '새로 생긴' 루트 엔트리만 제거한다. 되돌리지 못하는 두 부류가 남는다:
//     (a) 제자리 덮어쓴 파일 — package.json·README.md·.gitignore·renovate.json(+ install 진행도에 따라 bun.lock)는 수정된 채 남는다.
//         renovate.json은 템플릿 루트에도 있어 common/renovate.json이 '새 엔트리'가 아니라 덮어쓰기가 된다.
//     (b) 이미 있던 디렉토리 안에 들어간 파일 — .github/는 template-ci.yaml 때문에 존재하므로 '새 엔트리'가 아니고,
//         그 안의 .github/workflows/release.yaml은 untracked로 살아남는다.
//     완전 복구는 `git checkout . && git clean -fd` — checkout만으로는 untracked인 (b)가 지워지지 않는다.
//     복구 前엔 재실행조차 불가하다: (a)의 package.json 재작성이 scripts.scaffold를 지웠으므로 scaffold/가 남아 있어도
//     `bun run scaffold`는 `Script not found "scaffold"`로 죽는다 — 문서화된 진입점이 트리를 되돌려야 살아난다.
//     .git이 없는 사본(CI의 `rm -rf .git`)에선 그 복구가 불가능하니 템플릿 사본을 다시 떠야 한다. ---
const before = new Set(readdirSync(ROOT));
const rollback = () => { for (const e of readdirSync(ROOT)) if (!before.has(e) && e !== ".git") rmSync(join(ROOT, e), { recursive: true, force: true }); };
// 템플릿 자체가 어긋나 죽는 출구 — 사용자 입력 오류(exit 2)와 달리 고칠 주체는 템플릿 저자다.
const die = (m: string): never => { console.error(`❌ 템플릿 버그: ${m}`); rollback(); process.exit(1); };

// --- 문서 ↔ 코드 가드 (전개 前 — 어긋난 템플릿은 앱을 만들어 내보내지 않는다) ---
// DOC의 cmds·gates는 산문이지만 사실은 package.partial.json(스크립트)과 Dockerfile(게이트)에 있다.
// 어긋나면 README만 거짓말을 하고 이미지 빌드는 초록으로 남는다 — 주석으로 부탁하는 대신 여기서 죽인다(ADR-0001).
const ARCH_DIR = join(SCAFFOLD, "archetypes", archetype);
const partial = JSON.parse(readFileSync(join(ARCH_DIR, "package.partial.json"), "utf8"));
const promised = new Set([...doc.cmds.flatMap((c) => c.match(/^bun run ([\w:-]+)/)?.[1] ?? []), ...doc.gates]);
const missing = [...promised].filter((s) => !partial.scripts?.[s]);
if (missing.length) die(`DOC[${archetype}]가 약속한 스크립트가 archetypes/${archetype}/package.partial.json에 없다: ${missing.join(", ")}`);
// 게이트 추출은 게이트를 바꾸지 않는 편집(앞뒤 공백·줄끝 주석·`\` 줄이음·`&&` 레이어 병합 — 표준 도커 최적화다)에
// 걸려선 안 된다. 형식에 취약한 추출은 가드를 죽일 뿐 아니라 실패 메시지를 거짓말쟁이로 만든다(있는 게이트를 없다고 보고).
// 그래도 게이트의 추가·삭제·순서는 그대로 잡힌다 — 아래 비교가 순서까지 포함한 전체 열이므로.
const runs = readFileSync(join(ARCH_DIR, "Dockerfile"), "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/)
  .flatMap((l) => l.replace(/\s+#.*$/, "").match(/^\s*RUN\s+(.+)$/)?.[1].split("&&") ?? []) // RUN 줄만 → `&&` 체인 분해
  .flatMap((c) => c.trim().match(/^bun run ([\w:-]+)/)?.[1] ?? []); // bun run이 아닌 조각(bun install 등)은 게이트가 아니다
if (runs.join(" → ") !== doc.gates.join(" → ")) die(`DOC[${archetype}].gates(${doc.gates.join(" → ") || "없음"}) ≠ archetypes/${archetype}/Dockerfile의 게이트(${runs.join(" → ") || "없음"})`);

// --- 전개 ---
cpSync(join(SCAFFOLD, "common"), ROOT, { recursive: true });
cpSync(join(SCAFFOLD, "archetypes", archetype), ROOT, { recursive: true });
// 치환 누락(자리표시자 오타)은 조용히 앱 문서로 새어 나간다 — 렌더 후 {{...}}가 남으면 죽는다(fail-closed).
const render = (file: string, vars: Record<string, string>): string => {
  let out = readFileSync(join(ROOT, file), "utf8");
  for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{{${k}}}`, v);
  const left = [...new Set(out.match(/\{\{[^{}\n]+\}\}/g) ?? [])];
  if (left.length) die(`${file}: 치환되지 않은 자리표시자 ${left.join(", ")}`);
  return out;
};
writeFileSync(join(ROOT, "README.md"), render("README.app.md", {
  APP: name,
  ARCHETYPE: archetype,
  RUNTIME: doc.runtime,
  GATES: doc.gates.map((g) => `\`${g}\``).join(" → "),
  DEV_CMDS: doc.cmds.join("\n"),
  DEV_NOTE: doc.note.join("\n"),
  SECRET_NOTE: doc.secret,
}));
rmSync(join(ROOT, "README.app.md"));
// .env.example도 아키타입별로 갈린다 — DB 규약은 DB가 있는 아키타입(api)에만 넣는다.
writeFileSync(join(ROOT, ".env.example"), render(".env.example", { ENV_DB: doc.env.join("\n") }));

// --- .app-config.yml (homelab app-config-schema 계약) ---
const RES = kind === "site"
  ? { requests: { cpu: "10m", memory: "16Mi" }, limits: { cpu: "100m", memory: "32Mi" } }
  : { requests: { cpu: "50m", memory: "64Mi" }, limits: { cpu: "500m", memory: "128Mi" } };
// kind가 지원하지 않는 필드는 여기서 걸러진다(CAP 단일 출처) — 비호환 플래그가 산출물에 새지 않는다.
const cap = CAP[kind];
const cfg: Record<string, unknown> = { kind, resources: RES };
if (cap.route) cfg.route = { public: pub };
if (cap.probes) cfg.probes = { liveness: { path: "/healthz" }, readiness: { path: "/readyz" } };
if (cap.metrics && metrics) cfg.metrics = { enabled: true };
cfg.deploy = { autoDeploy };
writeFileSync(join(ROOT, ".app-config.yml"), toYaml(cfg));

// --- package.json 재작성 ---
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
pkg.name = name;
delete pkg.private;
delete pkg.scripts?.scaffold;
delete pkg.devDependencies?.["@clack/prompts"];
delete pkg.devDependencies?.yaml;
pkg.scripts = { ...pkg.scripts, ...partial.scripts }; // partial은 위 가드가 이미 읽었다(같은 파일을 두 번 읽지 않는다).
// 모든 앱은 SealedSecret 봉인 가능(common/tools/seal-secret.mts + cert 상속) — kubeseal CLI 필요.
// --app을 베이크해 봉인 산출물 이름(<app>-secrets)이 실행 디렉토리명이 아니라 앱 이름에서 파생되게 한다
// (미지정 시 seal-secret이 cwd basename으로 fallback → 클론 디렉토리명이 다르면 create-app 온보딩 검사에서 리젝).
// name은 NAME_RE(소문자/숫자/하이픈)를 통과했으므로 셸·JSON 인용을 깨뜨릴 문자가 없다.
pkg.scripts["secret:seal"] = `bun tools/seal-secret.mts --config .app-config.yml --env .env --app ${name}`;
if (partial.dependencies) pkg.dependencies = { ...pkg.dependencies, ...partial.dependencies };
if (partial.devDependencies) pkg.devDependencies = { ...pkg.devDependencies, ...partial.devDependencies };
writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
rmSync(join(ROOT, "package.partial.json"));

// --- lockfile 재생성(자가삭제 前) — package.json 재작성으로 deps가 바뀌었으므로 bun.lock도 갱신해야
//     Dockerfile의 `bun install --frozen-lockfile`이 첫 GHCR 빌드에서 통과한다. 실패 시 롤백+비0 종료. ---
const inst = Bun.spawnSync(["bun", "install"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (inst.exitCode !== 0) { console.error("❌ bun install(lock 재생성) 실패 — 새로 생긴 루트 엔트리만 제거했다. 제자리 수정(package.json·README.md·.gitignore·renovate.json, 경우에 따라 bun.lock)과 .github/workflows/release.yaml은 남아 있고, package.json 재작성으로 scripts.scaffold가 지워져 `bun run scaffold`는 더 이상 없다 — `git checkout . && git clean -fd`로 트리를 되돌려야 재실행할 수 있다(.git 없는 사본이면 템플릿 사본을 다시 뜰 것)"); rollback(); process.exit(1); }

// --- 템플릿 전용 머신러리 제거 (lock 재생성 성공 後에만 — 이 앞에서 지우면 롤백이 되돌리지 못하는
//     '지워진 원본'이 생겨 위 롤백 주석·실패 메시지가 거짓이 된다. 롤백은 '새로 생긴' 엔트리만 지운다). ---
rmSync(SCAFFOLD, { recursive: true, force: true });
rmSync(join(ROOT, ".github/workflows/template-ci.yaml"), { force: true });
// .bun-version은 템플릿 레포에만 있을 이유가 있다: Renovate가 bun을 올릴 수 있는 '쓰기 가능한' 파일이고
// (App 토큰에 workflows:write가 없어 워크플로엔 버전을 못 박는다) 그걸 읽는 건 템플릿 CI(setup-bun의
// bun-version-file)뿐이다. 앱엔 그 독자가 없다 — Dockerfile이 `FROM oven/bun:X`로 스스로 핀하고
// release.yaml은 homelab 재사용 워크플로를 부를 뿐 setup-bun을 쓰지 않는다. 그런데 Renovate엔 .bun-version을
// 읽는 내장 bun-version 매니저가 있어, 남겨두면 앱 레포마다 아무도 읽지 않는 파일을 올리는 renovate/bun-1.x
// PR이 영구히 열린다 — 죽은 파일을 실어 보내고 그걸 알아챈 봇을 앱 renovate.json에서 입막음하는 건 해법이 아니다.
rmSync(join(ROOT, ".bun-version"), { force: true });

outro(`✅ ${name} (${archetype}/${kind}) 스캐폴드 완료 — git add -A && git commit && git push → owner가 homelab create-app 디스패치`);
