// 최소 서버. /healthz는 공유 차트(web)의 기본 readiness probe 경로다.
// 포트는 차트가 env PORT로 넣는다(값은 homelab apps/<앱>/values.yaml의 port, 1024 이상).
export function handle(req: Request): Response {
  const { pathname } = new URL(req.url);
  if (pathname === "/healthz") return new Response("ok");
  return new Response("hello");
}

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 8080);
  const server = Bun.serve({ port, fetch: handle });
  console.log(`listening on :${port}`);
  // 컨테이너의 PID 1은 기본 처리기가 없어 SIGTERM을 무시한다. 없으면 배포·재시작마다 유예 시간(30초)을 다 기다린다.
  process.on("SIGTERM", async () => {
    await server.stop();
    process.exit(0);
  });
}
