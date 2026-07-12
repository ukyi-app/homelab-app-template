import { describe, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { Hono } from "hono";
import type { Pool } from "pg";
import { createApp } from "./index";

// pg Pool은 EventEmitter다 — 스텁도 진짜 EventEmitter여야 emit("error")가 프로덕션과 같은 경로를 탄다.
// 상태를 들고 있어 순단→회복 전이를 풀 하나로 재현한다.
class StubPool extends EventEmitter {
  asked: string[] = [];
  healthy = true;

  async query(sql: string) {
    this.asked.push(sql);
    if (!this.healthy) throw new Error("pooler down");
    return { rows: [] };
  }
}

const inject = (pool: StubPool): Hono => createApp(pool as unknown as Pool);
const get = (app: Hono, path: string) => app.fetch(new Request(`http://app${path}`));

// 서버 기동 없이(엔트리 가드 덕에) app.fetch로만 라우트를 검증한다.
// 무DB 앱 — readiness가 정적으로 통과해야 하는 분기.
const noDb = createApp(null);

describe("routes", () => {
  test("liveness는 DB와 무관하게 200", async () => {
    const res = await get(noDb, "/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("readiness — 무DB면 정적 통과", async () => {
    const res = await get(noDb, "/readyz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  test("readiness — 주입된 풀로 SELECT 1을 왕복하고 200", async () => {
    const pool = new StubPool();

    const res = await get(inject(pool), "/readyz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
    // 왕복이 없어지면(핸들러가 풀을 안 거치면) 여기서 깨진다 — readiness가 DB를 실제로 검증한다는 증거.
    expect(pool.asked).toEqual(["SELECT 1"]);
  });

  test("readiness — 주입된 풀의 왕복이 실패하면 503", async () => {
    const pool = new StubPool();
    pool.healthy = false;

    const res = await get(inject(pool), "/readyz");
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pooler down");
  });

  test("예제 API", async () => {
    const res = await get(noDb, "/api/hello");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Hello from Hono API" });
  });
});

describe("pg 풀 오류 격리", () => {
  test("주입된 풀도 프로덕션과 같은 준비 경로를 통과한다 — error 리스너가 붙는다", () => {
    const pool = new StubPool();

    inject(pool);

    // 리스너 등록이 풀 생성 함수(createPool/createRuntimePool)로 내려가면 주입 풀은 0이 된다 —
    // 그 순간 아래 복구 시퀀스는 스텁의 동작일 뿐 프로덕션 경로를 증명하지 못한다.
    expect(pool.listenerCount("error")).toBe(1);
  });

  test("복구 시퀀스 — 같은 풀로 error 생존 → readiness 503 → 회복 200", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      // 1) 순단(풀러 재시작/cnpg 페일오버/네트워크 파티션) — 유휴 커넥션이 error를 올린다.
      pool.healthy = false;
      const evicted = Object.assign(new Error("terminating connection due to administrator command"), {
        code: "57P01",
      });
      pool.emit("error", evicted);

      // 삼키되 침묵하지 않는다. 호출 여부가 아니라 내용을 고정한다 — 로그가 원인을 지목하지 못하면
      // 리스너의 유일한 관측 가치가 사라진다: 무엇이 끊었는지(message) + 어느 계층인지(code).
      expect(logged).toHaveBeenCalledTimes(1);
      const [line] = logged.mock.calls[0] as [unknown];
      // 에러 객체째 넘기면 pg가 err에 매단 Client까지 찍힌다(=DB password 평문) — 문자열로 좁힌다.
      expect(typeof line).toBe("string");
      expect(line).toContain("terminating connection due to administrator command");
      expect(line).toContain("57P01");
    } finally {
      logged.mockRestore();
    }

    // 2) 프로세스 생존 — liveness는 DB 상태와 무관하게 200(DB 일시장애로 파드가 죽지 않는다).
    expect((await get(app, "/healthz")).status).toBe(200);

    // 3) 순단 중에는 readiness가 503 — 트래픽만 빠진다.
    expect((await get(app, "/readyz")).status).toBe(503);

    // 4) 같은 풀이 회복되면(재연결) 다음 왕복에서 readiness가 다시 200 — 자동 회복.
    pool.healthy = true;
    expect((await get(app, "/readyz")).status).toBe(200);
  });
});
