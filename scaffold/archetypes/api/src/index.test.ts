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
  // 왕복이 무엇으로 깨지는지까지 스텁이 정한다 — pg는 Error만 reject하지 않는다(드라이버·미들웨어가 끼면
  // 임의의 남의 값이 올라온다). readiness 본문이 그 값을 어떻게 읽는지가 아래 표의 주제다.
  rejectWith: unknown = new Error("pooler down");

  async query(sql: string) {
    this.asked.push(sql);
    if (!this.healthy) throw this.rejectWith;
    return { rows: [] };
  }
}

const inject = (pool: StubPool): Hono => createApp(pool as unknown as Pool);
const get = (app: Hono, path: string) => app.fetch(new Request(`http://app${path}`));

// 왕복이 주어진 값으로 깨지는 풀 — readiness 503 본문만 보려는 테스트의 공통 준비.
const rejecting = (value: unknown): StubPool => {
  const pool = new StubPool();
  pool.healthy = false;
  pool.rejectWith = value;
  return pool;
};

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

// 503 본문은 로그보다 더 노출된 싱크다 — 파드에 닿는 누구나 curl로 읽고, k8s 이벤트/로그가 퍼 나른다.
// 그래서 로그와 *같은* 규율을 건다: 본문을 만들 때 남의 코드를 한 줄도 부르지 않는다(문자열화 훅도, getter도).
describe("readiness 503 본문 격리", () => {
  test("성공하는 getter는 실행조차 되지 않는다 — Error든 평범한 객체든", async () => {
    // ★Error 인스턴스가 이 핸들러의 진짜 구멍이다 — pg가 reject하는 건 Error이고, 옛 코드의
    //   `e instanceof Error ? e.message : ...`는 바로 그 Error에 대해 e.message를 *호출*했다.
    //   get message(){ return this.client.password } 하나면 SENTINEL_pw가 503 본문에 앉아 네트워크로 나간다.
    //   던지지 않으니 try/catch로는 잡히지도 않는다 — 경계는 "던지느냐"가 아니라 "부르느냐"다.
    let calls = 0;
    const leak = () => {
      calls++;
      return "SENTINEL_pw";
    };
    // getter는 defineProperty로 심는다 — Object.assign은 소스의 getter를 *호출*해 값을 복사하니까.
    const asError = Object.assign(new Error("benign"), { client: { password: "SENTINEL_pw" } });
    Object.defineProperty(asError, "message", { get: leak });
    const asPlain = { client: { password: "SENTINEL_pw" } };
    Object.defineProperty(asPlain, "message", { get: leak });

    for (const hostile of [asError, asPlain]) {
      const res = await get(inject(rejecting(hostile)), "/readyz");

      expect(res.status).toBe(503); // 계약은 그대로 — 왕복이 깨졌으면 트래픽이 빠진다.
      const body = await res.text();
      expect(body).not.toContain("SENTINEL_pw");
      expect(body).toContain("object"); // 값 대신 타입 — 사람이 "가서 로그를 보라"를 알기엔 충분하다.
    }

    expect(calls).toBe(0); // ★핵심 — 읽지 않았으니 부를 일도 없었다.
  });

  test("호출 가능한 값이 올라와도 문자열화 훅도 getter도 돌지 않는다", async () => {
    // String(e) 분기가 열어 준 구멍이다: typeof fn === "function"이면 Error가 아니니 String()으로 새고,
    // 그 순간 Symbol.toPrimitive/toString이 남의 코드로 돈다 — 반환값도, 매달린 password도 본문으로 나간다.
    let hookRan = false;
    const fn = Object.assign(() => {}, {
      client: { password: "SENTINEL_pw" },
      [Symbol.toPrimitive]: () => {
        hookRan = true;
        return "harmless-looking";
      },
    });
    Object.defineProperty(fn, "message", {
      get() {
        hookRan = true;
        return "SENTINEL_pw";
      },
    });

    const res = await get(inject(rejecting(fn)), "/readyz");

    expect(res.status).toBe(503);
    expect(hookRan).toBe(false); // ★남의 코드는 한 줄도 돌지 않았다.
    const body = await res.text();
    expect(body).not.toContain("SENTINEL_pw");
    expect(body).not.toContain("harmless-looking");
    expect(body).toContain("function"); // 값 대신 타입
  });

  test("읽는 것만으로 던지는 값이 올라와도 핸들러는 죽지 않고 503을 낸다", async () => {
    // catch 안에서 던지면 그 예외는 핸들러를 뚫고 나간다 — catch가 막으려던 바로 그 실패다.
    // 해지된 Proxy는 getOwnPropertyDescriptor 훅까지 던지므로 서술자 읽기의 try/catch가 마지막 방어선이다.
    const { proxy: revoked, revoke } = Proxy.revocable({ client: { password: "SENTINEL_pw" } }, {});
    revoke();
    // Error 인스턴스로 심는다 — 옛 코드는 Error에 대해서만 e.message를 읽었으므로 여기가 실제 폭발 지점이다.
    const throwing = Object.assign(new Error("benign"), { client: { password: "SENTINEL_pw" } });
    Object.defineProperty(throwing, "message", {
      get(): string {
        throw new Error("boom");
      },
    });

    for (const [value, expected] of [
      [throwing, "object"],
      [revoked, "object"],
    ] as [unknown, string][]) {
      const res = await get(inject(rejecting(value)), "/readyz");

      expect(res.status).toBe(503); // 크래시도 500도 아니다 — readiness 계약 그대로.
      const body = await res.text();
      expect(body).toContain(expected);
      expect(body).not.toContain("SENTINEL_pw");
      expect(body).not.toContain("boom"); // getter가 던진 예외가 진단을 덮어쓰면 안 된다.
    }

    // 프로세스가 살아 있다는 증거 — 앱이 그대로 서빙한다(liveness는 DB와 무관하게 200).
    expect((await get(noDb, "/healthz")).status).toBe(200);
  });

  test("진단은 죽지 않는다 — 평범한 Error의 message·code는 own 데이터라 본문에 그대로 남는다", async () => {
    // 접근자를 거절하는 규율이 진단까지 갉아먹지 않았는지 고정한다. 본문에 message가 남는 이유가 이것이다 —
    // 사람이 curl 한 번으로 "풀러가 축출했나(57P01)"를 알 수 있어야 하니까.
    const evicted = Object.assign(new Error("terminating connection due to administrator command"), {
      code: "57P01",
      client: { password: "SENTINEL_pw" }, // pg가 실제로 err에 매다는 것 — 읽지 않으므로 나가지 않는다.
    });

    const res = await get(inject(rejecting(evicted)), "/readyz");

    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain("terminating connection due to administrator command");
    expect(body).toContain("57P01");
    expect(body).not.toContain("SENTINEL_pw");
    // ★stack은 싣지 않는다 — 본문은 로그가 아니라 파드에 닿는 누구나 읽는 응답이다(절대경로·내부구조 유출).
    expect(body).not.toContain("src/index.ts");
    expect(body).not.toContain("at ");
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

  test("성공하는 getter는 실행조차 되지 않는다 — 함수에 매달렸든 평범한 객체든", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      // 이전 라운드는 *던지는* getter만 막았다(try/catch). 성공하는 getter는 그대로 신뢰됐고,
      // client.password를 돌려주는 get message() 하나로 자격증명이 로그에 앉았다.
      // 경계는 "던지느냐"가 아니라 "부르느냐"다 — 그래서 부른 뒤 검사하지 않고, 아예 부르지 않는다:
      // 접근자 서술자는 호출하지 않고 거절한다. calls===0이 그 증거다.
      let calls = 0;
      const leak = () => {
        calls++;
        return "SENTINEL_pw";
      };
      // getter는 defineProperty로 심는다 — Object.assign은 소스의 getter를 *호출*해 값을 복사하니까.
      const callable = Object.assign(() => {}, { client: { password: "SENTINEL_pw" } });
      Object.defineProperty(callable, "message", { get: leak });
      const plain = { client: { password: "SENTINEL_pw" } };
      Object.defineProperty(plain, "message", { get: leak });

      expect(() => pool.emit("error", callable)).not.toThrow();
      expect(() => pool.emit("error", plain)).not.toThrow();

      expect(calls).toBe(0); // ★핵심 — 읽지 않았으니 부를 일도 없었다.
      const lines = logged.mock.calls.map(([line]) => line as unknown);
      for (const line of lines) {
        expect(typeof line).toBe("string");
        expect(line).not.toContain("SENTINEL_pw");
      }
      expect(lines[0]).toContain("function"); // 값 대신 타입
      expect(lines[1]).toContain("object");
    } finally {
      logged.mockRestore();
    }

    expect((await get(app, "/healthz")).status).toBe(200);
  });

  test("진단은 죽지 않는다 — native Error의 message·code는 own 데이터라 그대로 남는다", () => {
    const pool = new StubPool();
    inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});

    try {
      // 접근자를 거절하는 규율이 진단까지 갉아먹지 않았는지 확인한다. 실측상 Bun의 native Error는
      // message·stack을 own *데이터* 프로퍼티로 들고 있고(접근자도 프로토타입도 아니다) pg는 code를
      // own 데이터로 매단다 — 그래서 정상 에러는 손실 없이 그대로 찍힌다.
      pool.emit("error", Object.assign(new Error("pooler restarted"), { code: "57P01" }));

      const [line] = logged.mock.calls[0] as [unknown];
      expect(typeof line).toBe("string");
      expect(line).toContain("pooler restarted");
      expect(line).toContain("57P01");
    } finally {
      logged.mockRestore();
    }
  });

  test("무엇이 올라오든 죽지 않고, 값이 아니라 타입으로 떨어진다", async () => {
    const pool = new StubPool();
    const app = inject(pool);
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const { proxy: revoked, revoke } = Proxy.revocable({}, {});
    revoke();

    // 구멍은 매번 "우리가 세어보지 못한 모양"에서 났다. 그래서 모양을 세는 대신 규율을 고정한다:
    // 무엇이 올라와도 (1) 리스너는 던지지 않고 (2) 줄은 문자열이며 (3) 매달린 값도 훅 반환값도 나오지 않고
    // (4) 남의 코드는 한 줄도 돌지 않는다(hookRan). 새 모양이 생겨도 이 표에 없을 뿐 결과는 같다 —
    // 기본값이 "타입만"이고, 읽기는 데이터 서술자만 채택하기 때문이다.
    let hookRan = false;
    const leak = () => {
      hookRan = true;
      return "SENTINEL_pw";
    };
    const withGetter = <T extends object>(base: T, key: "message" | "code" | "stack"): T =>
      Object.defineProperty(base, key, { get: leak });

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
      // 아래 6줄이 R-9 — 던지지 *않는* 읽기. e[key]였다면 전부 돌아서 password를 뱉었다.
      [withGetter(Object.assign(() => {}, { client: { password: "SENTINEL_pw" } }), "message"), "function"],
      [withGetter({ client: { password: "SENTINEL_pw" } }, "message"), "object"],
      [withGetter({ message: "benign message" }, "code"), "benign message"], // code는 거절, message는 살아남는다.
      [withGetter({ message: "benign message" }, "stack"), "benign message"], // stack은 거절, message로 떨어진다.
      [new Proxy({ client: { password: "SENTINEL_pw" } }, { get: () => leak() }), "object"], // get 트랩은 돌지 않는다.
      [new Error("native error message"), "native error message"], // ★진단 보존 — own 데이터 문자열은 그대로 나온다.
    ];

    try {
      for (const [e] of cases) expect(() => pool.emit("error", e)).not.toThrow();

      expect(logged).toHaveBeenCalledTimes(cases.length); // 삼키되 침묵하지 않는다 — 순단마다 한 줄.
      expect(hookRan).toBe(false); // ★남의 코드는 한 줄도 돌지 않았다.
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
