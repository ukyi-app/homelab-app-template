#!/usr/bin/env bun
// 대화형 스캐폴더 — 아키타입(fullstack/api/site/worker)을 선택해 즉시 배포 가능한 앱을 생성한다.
// pnpm create vite 류 UX. 실행 후 자기 자신을 삭제한다(앱 레포에 스캐폴드 머신러리 미잔존).
import { intro, outro, select, text, confirm, isCancel, cancel } from "@clack/prompts";
import { stringify as toYaml } from "yaml";
import { cpSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
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

async function ask(): Promise<{ archetype: Arch; name: string; pub: boolean; metrics: boolean; autoDeploy: boolean }> {
  if (NONINT) {
    const a = ((flags["--archetype"] as string) ?? "fullstack") as Arch;
    if (!ARCHES.includes(a)) { console.error(`--archetype은 ${ARCHES.join("|")} 중 하나`); process.exit(2); }
    return { archetype: a, name: validName((flags["--name"] as string) ?? basename(ROOT)), pub: flags["--public"] === true, metrics: flags["--metrics"] === true, autoDeploy: flags["--no-autodeploy"] !== true };
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
  const name = (await text({ message: "앱 이름", initialValue: basename(ROOT), validate: (v) => (NAME_RE.test(v) ? undefined : "소문자 시작·소문자/숫자/하이픈·trailing hyphen 금지·2..40자") })) as string;
  if (isCancel(name)) { cancel("취소"); process.exit(0); }
  const served = KIND[archetype] !== "worker";
  const pub = served ? ((await confirm({ message: "공개 노출(ukyi.app)? (아니오=home.ukyi.app 내부)", initialValue: false })) as boolean) : false;
  const metrics = KIND[archetype] === "web" ? ((await confirm({ message: "metrics(:9090) 활성?", initialValue: false })) as boolean) : false;
  const autoDeploy = (await confirm({ message: "autoDeploy?", initialValue: true })) as boolean;
  return { archetype, name, pub, metrics, autoDeploy };
}

const { archetype, name, pub, metrics, autoDeploy } = await ask();
const kind = KIND[archetype];

// --- 트랜잭션 롤백: 전개 前 루트 엔트리 스냅샷 → 실패 시 새 엔트리만 제거(재시도 가능) ---
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
const cfg: Record<string, unknown> = { kind, resources: RES };
if (kind !== "worker") cfg.route = { public: pub };
if (kind === "web") cfg.probes = { liveness: { path: "/healthz" }, readiness: { path: "/readyz" } };
if (kind === "web" && metrics) cfg.metrics = { enabled: true };
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
pkg.scripts["secret:seal"] = "bun tools/seal-secret.mts --config .app-config.yml --env .env";
if (partial.dependencies) pkg.dependencies = { ...pkg.dependencies, ...partial.dependencies };
if (partial.devDependencies) pkg.devDependencies = { ...pkg.devDependencies, ...partial.devDependencies };
writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
rmSync(join(ROOT, "package.partial.json"));

// --- lockfile 재생성(자가삭제 前) — package.json 재작성으로 deps가 바뀌었으므로 bun.lock도 갱신해야
//     Dockerfile의 `bun install --frozen-lockfile`이 첫 GHCR 빌드에서 통과한다. 실패 시 롤백+비0 종료. ---
const inst = Bun.spawnSync(["bun", "install"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
if (inst.exitCode !== 0) { console.error("❌ bun install(lock 재생성) 실패 — 생성 파일 롤백, scaffold/ 보존(재시도 가능)"); rollback(); process.exit(1); }

// --- 자가삭제 (lock 재생성 성공 후에만) ---
rmSync(SCAFFOLD, { recursive: true, force: true });
rmSync(join(ROOT, ".github/workflows/template-ci.yaml"), { force: true });

outro(`✅ ${name} (${archetype}/${kind}) 스캐폴드 완료 — git add -A && git commit && git push → owner가 homelab create-app 디스패치`);
