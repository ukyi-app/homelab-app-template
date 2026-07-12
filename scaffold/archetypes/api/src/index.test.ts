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
        client: { password: "SENTINEL_pw" }, // pg가 실제로 err에 매다는 것 — Client에 평문 password가 들어 있다.
      });
      pool.emit("error", evicted);

      // 삼키되 침묵하지 않는다. 호출 여부가 아니라 내용을 고정한다 — 로그가 원인을 지목하지 못하면
      // 리스너의 유일한 관측 가치가 사라진다: 무엇이 끊었는지(message) + 어느 계층인지(code).
      expect(logged).toHaveBeenCalledTimes(1);
      const [line] = logged.mock.calls[0] as [unknown];
      // 에러 객체째 넘기면 콘솔이 그 객체를 펼쳐 매달린 Client까지 찍는다(=DB password 평문).
      expect(typeof line).toBe("string");
      expect(line).not.toContain("SENTINEL_pw");
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

  test("필드를 읽는 것만으로 던지는 error가 올라와도 리스너는 죽지 않고 원인을 남긴다", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      // 리스너는 emit 스택 위에서 돈다 — 리스너 안에서 던지면 그 예외가 프로세스로 올라간다(리스너가
      // 막으려던 그 죽음). 프로퍼티 접근 자체가 던질 수 있다: throw하는 getter, 해지된 Proxy.
      const hostile = Object.assign(new Error("terminating connection due to administrator command"), {
        client: { password: "SENTINEL_pw" },
      });
      Object.defineProperty(hostile, "code", {
        get() {
          throw new Error("blew up");
        },
      });

      expect(() => pool.emit("error", hostile)).not.toThrow();

      // 폭발한 필드 하나 때문에 로그 전체를 잃지 않는다 — code는 포기해도 원인(message/stack)은 남아야 한다.
      expect(logged).toHaveBeenCalledTimes(1);
      const [line] = logged.mock.calls[0] as [unknown];
      expect(typeof line).toBe("string");
      expect(line).toContain("terminating connection due to administrator command");
      expect(line).not.toContain("SENTINEL_pw");
      // getter가 던진 예외가 진단을 덮어쓰면 안 된다 — 우리가 알고 싶은 건 풀을 끊은 원인이다.
      expect(line).not.toContain("blew up");
    } finally {
      logged.mockRestore();
    }

    // 프로세스가 살아 있다는 증거 — 앱이 그대로 서빙한다.
    expect((await get(app, "/healthz")).status).toBe(200);
  });

  test("호출 가능한 값이 올라와도 문자열화 훅은 아예 돌지 않는다", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      // 크래시 방어가 유출을 열었던 자리다: "원시값은 String()으로 찍자"고 하면 typeof fn === "function"인
      // 함수가 그 분기로 새고, String(fn)이 남의 훅을 부른다. 훅이 던지지만 않으면 그 반환값이 로그에 앉고,
      // 매달린 password도 훅이 원하는 순간 같이 나간다. 그래서 "훅을 부른 뒤 결과를 검사"하지 않는다 —
      // 아예 부르지 않는다.
      let hookRan = false;
      const fn = Object.assign(() => {}, {
        client: { password: "SENTINEL_pw" },
        [Symbol.toPrimitive]: () => {
          hookRan = true;
          return "harmless-looking";
        },
      });

      expect(() => pool.emit("error", fn)).not.toThrow();

      expect(hookRan).toBe(false);
      const [line] = logged.mock.calls[0] as [unknown];
      expect(typeof line).toBe("string");
      expect(line).not.toContain("SENTINEL_pw");
      expect(line).not.toContain("harmless-looking");
      expect(line).toContain("function"); // 값 대신 타입 — 사람이 "뭔가 올라왔으니 가서 보라"를 알기엔 충분하다.
    } finally {
      logged.mockRestore();
    }

    expect((await get(app, "/healthz")).status).toBe(200);
  });

  test("무엇이 올라오든 죽지 않고, 값이 아니라 타입으로 떨어진다", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    // 구멍은 매번 "우리가 세어보지 못한 모양"에서 났다. 그래서 모양을 세는 대신 규율을 고정한다:
    // 무엇이 올라와도 (1) 리스너는 던지지 않고 (2) 줄은 문자열이며 (3) 매달린 값도 훅 반환값도 나오지 않는다.
    // 새 모양이 생겨도 이 표에 없을 뿐 결과는 같다 — 허용목록의 기본값이 "타입만"이기 때문이다.
    const bait = { client: { password: "SENTINEL_pw" }, [Symbol.toPrimitive]: () => "SENTINEL_hook" };
    const cases: [unknown, string][] = [
      [null, "null"],
      [undefined, "undefined"],
      ["just a string", "just a string"], // 원시 문자열은 문자열화가 필요 없다 — 그대로 보여준다.
      [42, "42"],
      [10n, "10"],
      [Symbol("s"), "symbol"], // 보간했다면 TypeError로 죽는다 — 그래서 symbol은 원시값 분기에 없다.
      [Object.assign(Object.create(null), { client: { password: "SENTINEL_pw" } }), "object"], // toString이 아예 없다 — String()이었다면 TypeError.
      [bait, "object"],
      [Object.assign(() => {}, bait), "function"],
      [Object.assign(() => {}, { client: { password: "SENTINEL_pw" }, toString: () => "SENTINEL_hook" }), "function"],
      [{ get message(): string { throw new Error("boom"); } }, "object"], // 읽는 것 자체가 던진다.
      [revoked, "object"], // 해지된 Proxy — 모든 접근이 던진다.
    ];

    try {
      for (const [e] of cases) expect(() => pool.emit("error", e)).not.toThrow();

      expect(logged).toHaveBeenCalledTimes(cases.length); // 삼키되 침묵하지 않는다 — 순단마다 한 줄.
      cases.forEach(([, expected], i) => {
        const [line] = logged.mock.calls[i] as [unknown];
        expect(typeof line).toBe("string");
        expect(line).toContain(expected);
        expect(line).not.toContain("SENTINEL");
      });
    } finally {
      logged.mockRestore();
    }

    expect((await get(app, "/healthz")).status).toBe(200);
  });
});
