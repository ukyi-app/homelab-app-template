import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const app = new Hono();

// 런타임 계약(homelab 차트 probes)
app.get("/healthz", (c) => c.text("ok"));
app.get("/readyz", (c) => c.text("ready"));

// API
app.get("/api/hello", (c) => c.json({ message: "Hello from Hono" }));

// 빌드된 React SPA 서빙 + SPA fallback(클라이언트 라우팅)
app.use("/*", serveStatic({ root: "./web/dist" }));
app.get("/*", serveStatic({ path: "./web/dist/index.html" }));

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
