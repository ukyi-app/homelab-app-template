import { Hono } from "hono";
import { createRuntimePool } from "./db";

const app = new Hono();

// 런타임 풀(풀러 경유). DB가 설정되지 않은 앱이면 null — readiness가 정적으로 통과한다.
const db = createRuntimePool();

// 런타임 계약(homelab 차트 probes: liveness=/healthz, readiness=/readyz)
// liveness — 정적. DB 일시장애로 파드가 죽지 않게(라우트 검증은 readiness에서만).
app.get("/healthz", (c) => c.text("ok"));
// readiness — DB가 설정됐으면 풀러 경유 왕복으로 풀러/conn/롤 경로를 검증, 무DB면 정적 통과.
// ★앱별 스키마가 생기면 SELECT 1을 실제 테이블 왕복으로 교체하라(풀러/conn/롤/스키마를 함께 검증).
app.get("/readyz", async (c) => {
  if (!db) return c.text("ready");
  try {
    await db.query("SELECT 1");
    return c.text("ready");
  } catch (e) {
    return c.text(`not ready: ${e instanceof Error ? e.message : String(e)}`, 503);
  }
});

// API
app.get("/api/hello", (c) => c.json({ message: "Hello from Hono API" }));

const port = Number(process.env.PORT ?? 8080);
const server = Bun.serve({ port, fetch: app.fetch });
console.log(`listening :${port}`);

// metrics(:9090) — homelab 차트가 metrics.enabled=true일 때 scrape. 항상 떠도 경량.
const metricsPort = Number(process.env.METRICS_PORT ?? 9090);
const started = Date.now();
const metricsServer = Bun.serve({
  port: metricsPort,
  fetch: () =>
    new Response(
      `# HELP app_uptime_seconds 프로세스 가동시간\n# TYPE app_uptime_seconds gauge\napp_uptime_seconds ${(Date.now() - started) / 1000}\n`,
      { headers: { "content-type": "text/plain; version=0.0.4" } },
    ),
});

// distroless에서 앱은 PID 1 — 핸들러 없는 시그널은 커널이 기본 종료시키지 않고 무시한다.
// 두 서버를 다 세워야 프로세스가 유예시간(30s) 안에 스스로 끝난다(SIGKILL/exit 137 회피).
// stop(true)로 in-flight 커넥션까지 즉시 끊되, 그 promise는 기다리지 않는다 — in-flight 요청이
// 하나라도 있으면 stop()은 핸들러가 끝나야 resolve되므로(true여도 마찬가지), await하면 exit에
// 영영 도달하지 못하고 유예시간을 태운다. 드레인은 차트(preStop)의 몫이다.
const shutdown = () => {
  server.stop(true);
  metricsServer.stop(true);
  console.log("stopped");
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
