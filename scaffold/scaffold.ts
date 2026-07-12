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

// 배포 식별자는 레포명 하나에서 파생된다(ADR-0002) — 유도값과 다른 이름은 경고만 한다.
// 하드 강제는 homelab create-app이 하고, CI가 임시 디렉토리에서 `--name ci-<archetype>`으로
// 스캐폴드하는 정당한 사용처가 있어 여기서 실패시키면 안 된다.
if (name !== derived) warn(`앱 이름 '${name}'이(가) 유도값 '${derived}'와 다르다 — 이 값은 배포 식별자가 아니며 GitHub 레포명과 같아야 한다(create-app이 repoName === app을 강제).`);

// --- 롤백: 전개 前 루트 엔트리 스냅샷 → 실패 시 '새로 생긴' 루트 엔트리만 제거한다. 되돌리지 못하는 두 부류가 남는다:
//     (a) 제자리 덮어쓴 파일 — package.json·README.md·.gitignore(+ install 진행도에 따라 bun.lock)는 수정된 채 남는다.
//     (b) 이미 있던 디렉토리 안에 들어간 파일 — .github/는 template-ci.yaml 때문에 존재하므로 '새 엔트리'가 아니고,
//         그 안의 .github/workflows/release.yaml은 untracked로 살아남는다.
//     완전 복구는 `git checkout . && git clean -fd` — checkout만으로는 untracked인 (b)가 지워지지 않는다.
//     복구 前엔 재실행조차 불가하다: (a)의 package.json 재작성이 scripts.scaffold를 지웠으므로 scaffold/가 남아 있어도
//     `bun run scaffold`는 `Script not found "scaffold"`로 죽는다 — 문서화된 진입점이 트리를 되돌려야 살아난다.
//     .git이 없는 사본(CI의 `rm -rf .git`)에선 그 복구가 불가능하니 템플릿 사본을 다시 떠야 한다. ---
const before = new Set(readdirSync(ROOT));
const rollback = () => { for (const e of readdirSync(ROOT)) if (!before.has(e) && e !== ".git") rmSync(join(ROOT, e), { recursive: true, force: true }); };

// --- 전개 ---
cpSync(join(SCAFFOLD, "common"), ROOT, { recursive: true });
cpSync(join(SCAFFOLD, "archetypes", archetype), ROOT, { recursive: true });
const readme = readFileSync(join(ROOT, "README.app.md"), "utf8").replaceAll("{{APP}}", name).replaceAll("{{ARCHETYPE}}", archetype);
writeFileSync(join(ROOT, "README.md"), readme);
rmSync(join(ROOT, "README.app.md"));

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
const partial = JSON.parse(readFileSync(join(ROOT, "package.partial.json"), "utf8"));
pkg.scripts = { ...pkg.scripts, ...partial.scripts };
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
if (inst.exitCode !== 0) { console.error("❌ bun install(lock 재생성) 실패 — 새로 생긴 루트 엔트리만 제거했다. 제자리 수정(package.json·README.md·.gitignore, 경우에 따라 bun.lock)과 .github/workflows/release.yaml은 남아 있고, package.json 재작성으로 scripts.scaffold가 지워져 `bun run scaffold`는 더 이상 없다 — `git checkout . && git clean -fd`로 트리를 되돌려야 재실행할 수 있다(.git 없는 사본이면 템플릿 사본을 다시 뜰 것)"); rollback(); process.exit(1); }

// --- 자가삭제 (lock 재생성 성공 후에만) ---
rmSync(SCAFFOLD, { recursive: true, force: true });
rmSync(join(ROOT, ".github/workflows/template-ci.yaml"), { force: true });

outro(`✅ ${name} (${archetype}/${kind}) 스캐폴드 완료 — git add -A && git commit && git push → owner가 homelab create-app 디스패치`);
