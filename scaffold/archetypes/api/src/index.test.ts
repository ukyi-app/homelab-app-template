import { describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { createApp } from "./index";

// 서버 기동 없이(엔트리 가드 덕에) app.fetch로만 라우트를 검증한다.
// 무DB 앱 — readiness가 정적으로 통과해야 하는 분기.
const noDb = createApp(null);

describe("routes", () => {
  test("liveness는 DB와 무관하게 200", async () => {
    const res = await noDb.fetch(new Request("http://app/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("readiness — 무DB면 정적 통과", async () => {
    const res = await noDb.fetch(new Request("http://app/readyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  test("readiness — 주입된 풀로 SELECT 1을 왕복하고 200", async () => {
    const asked: string[] = [];
    const pool = {
      query: async (sql: string) => {
        asked.push(sql);
        return { rows: [] };
      },
    } as unknown as Pool;

    const res = await createApp(pool).fetch(new Request("http://app/readyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
    // 왕복이 없어지면(핸들러가 풀을 안 거치면) 여기서 깨진다 — readiness가 DB를 실제로 검증한다는 증거.
    expect(asked).toEqual(["SELECT 1"]);
  });

  test("readiness — 주입된 풀의 왕복이 실패하면 503", async () => {
    const pool = {
      query: async () => {
        throw new Error("pooler down");
      },
    } as unknown as Pool;

    const res = await createApp(pool).fetch(new Request("http://app/readyz"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("pooler down");
  });

  test("예제 API", async () => {
    const res = await noDb.fetch(new Request("http://app/api/hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Hello from Hono API" });
  });
});
