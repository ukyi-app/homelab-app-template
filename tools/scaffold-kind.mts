// kind별 앱 골격 생성기. 템플릿 root는 공통 도구만 갖고, 실제 런타임 코드는 여기서 복사한다.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

type Kind = "service" | "static" | "worker";
type Args = { kind?: Kind; root: string; force: boolean };

function die(message: string): never {
  console.error(`scaffold: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { root: process.cwd(), force: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--kind") {
      const value = argv[++i] as Kind | undefined;
      if (!value || !["service", "static", "worker"].includes(value)) die("--kind는 service|static|worker 중 하나여야 한다");
      args.kind = value;
    } else if (arg === "--root") {
      args.root = argv[++i] ?? die("--root 값이 필요하다");
    } else if (arg === "--force") {
      args.force = true;
    } else {
      die(`알 수 없는 인자: ${arg}`);
    }
  }
  if (!args.kind) die("--kind <service|static|worker> 필수");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const templateRoot = join(dirname(new URL(import.meta.url).pathname), "..", "templates", args.kind!);
const filesRoot = join(templateRoot, "files");
if (!existsSync(filesRoot)) die(`템플릿 파일을 찾지 못했다: ${relative(process.cwd(), filesRoot)}`);

function copyTree(src: string, destRoot: string) {
  for (const entry of readdirSync(src)) {
    const from = join(src, entry);
    const to = join(destRoot, entry);
    const st = statSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTree(from, to);
      continue;
    }
    if (existsSync(to) && !args.force) die(`${relative(destRoot, to)} already exists (use --force to overwrite)`);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { force: args.force });
  }
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function mergePackageJson() {
  const packagePath = join(args.root, "package.json");
  const patchPath = join(templateRoot, "package.patch.json");
  const pkg = readJson(packagePath);
  const patch = readJson(patchPath);
  for (const key of ["scripts", "dependencies", "devDependencies"] as const) {
    if (!patch[key]) continue;
    pkg[key] = { ...(pkg[key] ?? {}), ...patch[key] };
  }
  writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");
}

function stripBlock(text: string, key: string) {
  const lines = text.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${key}:\\s*`).test(lines[i] ?? "")) {
      i++;
      while (i < lines.length && (/^\s/.test(lines[i] ?? "") || (lines[i] ?? "") === "")) i++;
      i--;
      continue;
    }
    out.push(lines[i] ?? "");
  }
  return out.join("\n");
}

function updateAppConfig() {
  const configPath = join(args.root, ".app-config.yml");
  let config = readFileSync(configPath, "utf8");
  const kindLine = `kind: ${args.kind}              # service | worker | static`;
  if (/^kind:\s*.*$/m.test(config)) config = config.replace(/^kind:\s*.*$/m, kindLine);
  else config = `${kindLine}\n${config}`;

  // worker는 HTTP surface가 없고, static.server는 외부 계약에서 숨긴다.
  config = stripBlock(config, "static");
  if (args.kind === "worker") config = stripBlock(config, "route");

  writeFileSync(configPath, config.endsWith("\n") ? config : `${config}\n`);
}

copyTree(filesRoot, args.root);
mergePackageJson();
updateAppConfig();

console.log(`scaffolded ${args.kind} app into ${basename(args.root)}`);
if (args.kind === "static") console.log("next: run pnpm install to update pnpm-lock.yaml before pushing");
