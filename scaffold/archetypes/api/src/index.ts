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
Bun.serve({ port, fetch: app.fetch });
console.log(`listening :${port}`);

// metrics(:9090) — homelab 차트가 metrics.enabled=true일 때 scrape. 항상 떠도 경량.
const metricsPort = Number(process.env.METRICS_PORT ?? 9090);
const started = Date.now();
Bun.serve({
  port: metricsPort,
  fetch: () =>
    new Response(
      `# HELP app_uptime_seconds 프로세스 가동시간\n# TYPE app_uptime_seconds gauge\napp_uptime_seconds ${(Date.now() - started) / 1000}\n`,
      { headers: { "content-type": "text/plain; version=0.0.4" } },
    ),
});
