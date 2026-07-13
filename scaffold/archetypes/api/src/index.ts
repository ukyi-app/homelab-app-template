import { Hono } from "hono";
import type { Pool } from "pg";
// ★ownString(프로퍼티를 데이터 서술자로만 읽는 규율 — 접근자·Proxy 트랩을 부르지 않는다)은 db.ts에서
//   가져온다. 여기 한 벌 더 두면 한쪽만 굳고, 손대지 않은 쪽에서 유출 구멍이 조용히 다시 열린다 —
//   이 아키타입 안에서 읽기 규율의 구현은 하나여야 한다(WHY 전문은 db.ts의 export에).
//   공유하는 건 *읽기*뿐이다: 아래 본문 포매터는 로그(db.ts errLine)와 달리 stack을 싣지 않는다.
import { createRuntimePool, ownString, preparePool } from "./db";

// readiness 실패 본문 한 줄 — ★던지지 않고(던지면 핸들러가 죽는다), ★남의 코드를 부르지 않는다.
//   String()·toString·Symbol.toPrimitive·템플릿 보간은 전부 남의 코드 실행이라 금지다.
// ★본문 정책 — code + message만 싣고 stack은 싣지 않는다. 이 본문은 로그가 아니라 파드에 닿는 누구에게나
//   보이는 HTTP 응답이다(차트의 readiness probe는 상태코드만 본다; 본문은 curl로 들여다보는 사람 몫이고,
//   k8s 이벤트/로그가 이걸 그대로 퍼 나를 수 있다). 그래서 "왜 안 되는지"를 지목하는 최소치만 남긴다:
//   code는 계층을 가르고(57P01 풀러 축출 / 28P01 인증실패 / ECONNREFUSED 네트워크), message는 사람이 읽을
//   원인이다. stack은 그 대가로 절대경로·내부구조까지 흘리므로 로그(db.ts)에만 남기고 네트워크로 내보내지 않는다.
const notReadyBody = (e: unknown): string => {
  const noDetail = (t: string) => `(읽을 수 있는 message 없음: ${t})`;
  try {
    // 원시값만 값 자체를 보여준다 — number·boolean·bigint의 ToString은 스펙 내부 연산이라 프로토타입도
    // 훅도 거치지 않는다(symbol은 보간하면 TypeError로 죽으므로 이 분기에 없다).
    if (typeof e === "string") return `not ready (code=none): ${e}`;
    if (typeof e === "number" || typeof e === "boolean" || typeof e === "bigint") return `not ready (code=none): ${e}`;
    // ★필드를 읽을 자격은 평범한 객체에만 준다 — 호출 가능한 값에 get message()를 달아 password를 흘릴 수
    //   있다. 함수·심볼·undefined·null은 읽기 전에 타입으로 떨어뜨린다: 읽지 않으면 부를 일도 없다.
    if (e === null) return `not ready (code=none): ${noDetail("null")}`;
    if (typeof e !== "object") return `not ready (code=none): ${noDetail(typeof e)}`;
    return `not ready (code=${ownString(e, "code") ?? "none"}): ${ownString(e, "message") ?? noDetail("object")}`;
  } catch {
    // 도달 불가여야 한다(위 조각은 전부 확인된 문자열이다). 그래도 남긴다 — 여기서 던지면 핸들러가 죽는다.
    return "not ready (code=?): (본문 조립 실패)";
  }
};

// env가 만든 풀도 테스트가 주입한 풀도 이 파라미터 한 지점으로 수렴한다 — 주입이 프로덕션의 풀 준비를
// 우회할 수 없다. DB가 설정되지 않은 앱이면 풀이 null이고 readiness가 정적으로 통과한다.
export function createApp(db: Pool | null = createRuntimePool()): Hono {
  preparePool(db);
  const app = new Hono();

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
      // ★e를 그대로 보간하지 않는다 — notReadyBody가 만든 문자열 하나만 넘긴다.
      return c.text(notReadyBody(e), 503);
    }
  });

  // API
  app.get("/api/hello", (c) => c.json({ message: "Hello from Hono API" }));

  return app;
}

// 엔트리 가드 — 서버 기동은 직접 실행할 때만. 테스트가 app을 import해도 포트를 잡지 않는다.
if (import.meta.main) {
  const app = createApp();

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
}
