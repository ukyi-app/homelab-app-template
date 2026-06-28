import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProject() {
  const dir = mkdtempSync(join(tmpdir(), "homelab-template-scaffold-"));
  temps.push(dir);
  writeFileSync(
    join(dir, ".app-config.yml"),
    [
      "kind: service              # service | worker | static",
      "resources:",
      "  requests: { cpu: 50m, memory: 64Mi }",
      "  limits: { cpu: 500m, memory: 128Mi }",
      "route:",
      "  public: false",
      "deploy:",
      "  autoDeploy: true",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "demo",
      private: true,
      type: "module",
      scripts: {
        "scaffold": "bun tools/scaffold-kind.mts",
        "secret:seal": "bun tools/seal-secret.mts --config .app-config.yml --env .env",
      },
    }, null, 2) + "\n",
  );
  return dir;
}

function runScaffold(root: string, kind: string) {
  return Bun.spawnSync({
    cmd: [process.execPath, "tools/scaffold-kind.mts", "--kind", kind, "--root", root],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("static scaffold creates a Vite SWS app without exposing static.server", () => {
  const root = makeProject();

  const result = runScaffold(root, "static");

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, ".app-config.yml"), "utf8")).toContain("kind: static");
  expect(readFileSync(join(root, ".app-config.yml"), "utf8")).not.toContain("static:");
  expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("static-web-server");
  expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("/public");
  expect(readFileSync(join(root, "vite.config.ts"), "utf8")).toContain("defineConfig");
  expect(readFileSync(join(root, "index.html"), "utf8")).toContain('id="app"');

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.scripts.dev).toBe("vite --host 0.0.0.0");
  expect(pkg.scripts.build).toBe("vite build");
  expect(pkg.devDependencies.vite).toBeDefined();
});

test("service scaffold creates the /health Bun service contract", () => {
  const root = makeProject();

  const result = runScaffold(root, "service");

  expect(result.exitCode).toBe(0);
  expect(readFileSync(join(root, ".app-config.yml"), "utf8")).toContain("kind: service");
  expect(readFileSync(join(root, "Dockerfile"), "utf8")).toContain("GET /health");
  expect(readFileSync(join(root, "src/index.ts"), "utf8")).toContain('pathname === "/health"');

  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  expect(pkg.scripts.dev).toBe("bun run --hot src/index.ts");
  expect(pkg.scripts.build).toContain("bun build src/index.ts");
});

test("scaffold refuses to overwrite generated files unless --force is used", () => {
  const root = makeProject();
  writeFileSync(join(root, "Dockerfile"), "FROM scratch\n");

  const result = runScaffold(root, "worker");

  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("already exists");
  expect(readFileSync(join(root, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
});
