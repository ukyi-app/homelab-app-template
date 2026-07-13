import { describe, expect, spyOn, test } from "bun:test";
import { BACKOFF_MS, INTERVAL_MS, createWorker } from "./index";

// 이 파일이 import되고도 tick이 돌지 않는다는 사실 자체가 엔트리 가드(import.meta.main)의 증거다 —
// 가드가 빠지면 import 시점에 while이 돌아 이 파일은 초록도 빨강도 못 되고 영영 끝나지 않는다.

// 루프를 '한 주기'만 돌린다 — 던지는 work 하나로 프로덕션의 catch를 그대로 지나간다.
// ★errLine을 직접 부르지 않는 이유 — 그러면 `console.error(errLine(e))`가 `console.error(e)`로 되돌아가도
//   초록이다. 포매터가 무엇을 만드느냐만큼 콘솔에 *무엇을 넘겼느냐*가 규율이다(객체를 넘기면 Bun의 인스펙터가
//   펼쳐서 매달린 password를 찍는다 — 그게 1라운드다).
// ★work 안에서 먼저 stop()한다 — 실패 후 백오프 sleep(1s)이 즉시 풀려 표 20행이 20초를 태우지 않는다.
//   백오프를 '실제로' 요청하는지는 아래 지연 테스트가 따로 고정한다.
const throwOnce = async (thrown: unknown): Promise<void> => {
  let stop = (): void => {};
  const worker = createWorker(() => {
    stop();
    throw thrown;
  });
  stop = worker.stop;
  await worker.run();
};

// 콘솔은 두 개 다 막는다 — error는 검사 대상이고, log(worker started/stopped·tick)는 소음이다.
const captureConsole = () => {
  const error = spyOn(console, "error").mockImplementation(() => {});
  const log = spyOn(console, "log").mockImplementation(() => {});
  return {
    lines: (): unknown[] => error.mock.calls.map(([line]) => line as unknown),
    logs: (): unknown[] => log.mock.calls.map(([line]) => line as unknown),
    restore: () => {
      error.mockRestore();
      log.mockRestore();
    },
  };
};

describe("루프 계약(I-1)", () => {
  test("잠든 sleep은 종료 신호에 즉시 깨고, 타이머 핸들을 남기지 않는다", async () => {
    // 이 계약이 깨지면 파드는 남은 주기(5s)를 태우다 유예시간을 넘겨 SIGKILL(exit 137)을 맞는다.
    // 타이머를 해제하지 않으면 이벤트 루프에 핸들이 남아 exit()이 없는 실행 경로에서 프로세스가 안 끝난다.
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const delays: number[] = [];
    const handles: unknown[] = [];
    const cleared: unknown[] = [];
    const st = spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      const h = realSetTimeout(cb, ms);
      handles.push(h);
      return h;
    }) as unknown as typeof globalThis.setTimeout);
    const ct = spyOn(globalThis, "clearTimeout").mockImplementation(((h?: unknown) => {
      cleared.push(h);
      realClearTimeout(h as ReturnType<typeof setTimeout>);
    }) as unknown as typeof globalThis.clearTimeout);
    const con = captureConsole();

    try {
      const worker = createWorker(() => {}); // 즉시 끝나는 tick — 워커는 곧바로 sleep 안으로 들어간다.
      const done = worker.run();
      for (let i = 0; i < 50 && delays.length === 0; i++) await Promise.resolve(); // 마이크로태스크만으로 sleep에 닿는다

      expect(delays[0]).toBe(INTERVAL_MS); // 진짜 주기만큼 자고 있다 — 짧은 타이머로 통과하는 가짜 초록 방지
      const t0 = performance.now();
      worker.stop();
      // race를 거는 이유 — 중단 불가 sleep 회귀는 5s를 채우고, 그건 러너의 테스트 타임아웃과 구분이 안 된다.
      const outcome = await Promise.race([done.then(() => "stopped"), Bun.sleep(1000).then(() => "timeout")]);

      expect(outcome).toBe("stopped");
      expect(performance.now() - t0).toBeLessThan(500); // 남은 주기(5s)를 태우지 않았다
      expect(cleared).toContain(handles[0]); // ★깨워 놓고 타이머를 남기지 않는다
      expect(con.logs()).toContain("worker stopped"); // 루프를 정상적으로 빠져나왔다(계약 로그)
    } finally {
      st.mockRestore();
      ct.mockRestore();
      con.restore();
    }
  });

  test("루프 본문의 예외는 흡수된다 — 로그 한 줄 + 백오프 + 워커 생존", async () => {
    // 세 가지를 한 번에 고정한다: (1) 죽지 않는다 (2) 다음 대기가 백오프로 짧아진다 (3) 다음 주기가 실제로 돈다.
    // ★지연은 '기다리지 않고' 관측한다 — 계약은 얼마나 잤느냐가 아니라 무슨 지연을 요청했느냐다
    //   (진짜로 자면 이 테스트가 6초를 태운다. 실제 대기·기상은 위 테스트가 진짜 타이머로 이미 고정했다).
    const delays: number[] = [];
    const st = spyOn(globalThis, "setTimeout").mockImplementation(((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0);
      queueMicrotask(cb); // 즉시 깨운다
      return 0;
    }) as unknown as typeof globalThis.setTimeout);
    const con = captureConsole();

    try {
      const boom = Object.assign(new Error("transient failure"), { client: { password: "SENTINEL_pw" } });
      let calls = 0;
      let stop = (): void => {};
      const worker = createWorker(() => {
        calls++;
        if (calls === 1) throw boom; // 1주기: 실패 → 백오프
        if (calls === 3) stop(); // 3주기: 정리(2주기의 성공이 정상 주기를 요청했는지 보고 끝낸다)
      });
      stop = worker.stop;

      await expect(worker.run()).resolves.toBeUndefined(); // 예외가 루프를 뚫고 나오지 않았다

      expect(calls).toBe(3); // 실패 뒤에도 주기가 계속 돈다 — 워커가 살아남았다
      expect(delays).toEqual([BACKOFF_MS, INTERVAL_MS]); // 실패 뒤엔 백오프, 성공 뒤엔 정상 주기
      const lines = con.lines();
      expect(lines).toHaveLength(1); // 삼키되 침묵하지 않는다
      expect(typeof lines[0]).toBe("string"); // ★e를 통째로 넘기면 콘솔이 펼쳐 password를 찍는다
      expect(lines[0]).toContain("transient failure");
      expect(lines[0]).not.toContain("SENTINEL_pw");
      expect(con.logs()).toContain("worker stopped");
    } finally {
      st.mockRestore();
      con.restore();
    }
  });

  test("백오프는 0이 아니고 정상 주기보다 짧다", () => {
    // 0이면 실패가 반복될 때 busy-loop이 되고(CPU 리밋을 태운다), 주기보다 길면 '백오프'라는 이름이 거짓말이다.
    expect(BACKOFF_MS).toBeGreaterThan(0);
    expect(BACKOFF_MS).toBeLessThan(INTERVAL_MS);
  });
});

// 루프가 삼키는 값은 '임의의 남의 값'이다 — TODO 자리가 DB·SDK 호출로 채워지는 순간 그 값엔 자격증명이 매달린다
// (실측: pg는 err에 Client를 매달아 DB password를 평문으로 들고 있다). 그래서 로그 한 줄을 만들 때 남의 코드를
// 한 줄도 부르지 않는다 — 문자열화 훅도, getter도, Proxy 트랩도. api의 src/db.ts가 같은 이유로 같은 규율을 쓴다.
describe("throw된 값 격리", () => {
  test("성공하는 getter는 실행조차 되지 않는다 — 함수에 매달렸든 평범한 객체든", async () => {
    // 이전 라운드는 *던지는* getter만 막았다(try/catch). 성공하는 getter는 그대로 신뢰됐고,
    // client.password를 돌려주는 get message() 하나로 자격증명이 로그에 앉았다.
    // 경계는 "던지느냐"가 아니라 "부르느냐"다 — 부른 뒤 검사하지 않고, 아예 부르지 않는다: 접근자 서술자는
    // 호출하지 않고 거절한다. calls===0이 그 증거다.
    const con = captureConsole();
    try {
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

      await throwOnce(callable);
      await throwOnce(plain);

      expect(calls).toBe(0); // ★핵심 — 읽지 않았으니 부를 일도 없었다.
      const lines = con.lines();
      for (const line of lines) {
        expect(typeof line).toBe("string");
        expect(line).not.toContain("SENTINEL_pw");
      }
      expect(lines[0]).toContain("function"); // 값 대신 타입
      expect(lines[1]).toContain("object");
    } finally {
      con.restore();
    }
  });

  test("호출 가능한 값이 던져져도 문자열화 훅은 아예 돌지 않는다", async () => {
    // 크래시 방어가 유출을 열었던 자리다: "원시값은 String()으로 찍자"고 하면 typeof fn === "function"인
    // 함수가 그 분기로 새고, String(fn)이 남의 훅을 부른다. 훅이 던지지만 않으면 그 반환값이 로그에 앉고,
    // 매달린 password도 훅이 원하는 순간 같이 나간다. 그래서 훅을 부른 뒤 결과를 검사하지 않는다 — 아예 부르지 않는다.
    const con = captureConsole();
    try {
      let hookRan = false;
      const fn = Object.assign(() => {}, {
        client: { password: "SENTINEL_pw" },
        [Symbol.toPrimitive]: () => {
          hookRan = true;
          return "harmless-looking";
        },
      });

      await throwOnce(fn);

      expect(hookRan).toBe(false); // ★남의 코드는 한 줄도 돌지 않았다.
      const [line] = con.lines();
      expect(typeof line).toBe("string");
      expect(line).not.toContain("SENTINEL_pw");
      expect(line).not.toContain("harmless-looking");
      expect(line).toContain("function"); // 값 대신 타입
    } finally {
      con.restore();
    }
  });

  test("읽는 것만으로 던지는 값이 올라와도 워커는 죽지 않는다", async () => {
    // catch 안에서 던지면 그 예외는 루프를 뚫고 나가 워커를 죽인다 — catch가 막으려던 바로 그 실패다.
    // 해지된 Proxy는 getOwnPropertyDescriptor 훅까지 던지므로 서술자 읽기의 try/catch가 마지막 방어선이다.
    const con = captureConsole();
    try {
      // Error 인스턴스로 심는다 — 옛 코드는 Error에 대해 e.message를 *불렀으므로* 여기가 실제 폭발 지점이었다.
      // 지금은 접근자 서술자를 거절하니 그 getter는 아예 돌지 않는다(던질 기회조차 없다). 그래서 폭발도 없고,
      // own 데이터인 stack이 그대로 남아 진단까지 산다 — 적대적인 message 하나가 로그 전체를 삼키지 못한다.
      const throwing = Object.assign(new Error("benign"), { client: { password: "SENTINEL_pw" } });
      Object.defineProperty(throwing, "message", {
        get(): string {
          throw new Error("boom");
        },
      });
      const { proxy: revoked, revoke } = Proxy.revocable({ client: { password: "SENTINEL_pw" } }, {});
      revoke(); // 서술자 훅 자체가 던진다 — 읽을 수 있는 게 하나도 없으니 타입으로 떨어진다.

      const cases: [unknown, string][] = [
        [throwing, "at "], // stack 프레임 — 진단이 살아남았다
        [revoked, "object"], // 값 대신 타입
      ];
      for (const [hostile] of cases) {
        await expect(throwOnce(hostile)).resolves.toBeUndefined(); // 루프가 정상 종료했다 = 죽지 않았다
      }

      const lines = con.lines();
      cases.forEach(([, expected], i) => {
        expect(typeof lines[i]).toBe("string");
        expect(lines[i]).toContain(expected);
        expect(lines[i]).not.toContain("SENTINEL_pw");
        expect(lines[i]).not.toContain("boom"); // getter가 던진 예외가 진단을 덮어쓰면 안 된다
      });
    } finally {
      con.restore();
    }
  });

  test("Object.prototype.value가 오염돼도 접근자 서술자는 거절된다", async () => {
    // hasOwn 대신 `"value" in d`였다면 여기서 무너진다: 서술자의 프로토타입은 Object.prototype이라
    // 오염된 getter가 in을 true로 만들고, 이어지는 d.value가 *그 상속 getter*를 부른다 —
    // 접근자 서술자를 데이터인 척 통과시키는 우회로다(막으려던 바로 그 호출이 돈다).
    const con = captureConsole();
    let polluted = false;
    const hostile = { client: { password: "SENTINEL_pw" } };
    Object.defineProperty(hostile, "message", { get: () => "SENTINEL_pw" });

    try {
      Object.defineProperty(Object.prototype, "value", {
        configurable: true,
        get() {
          polluted = true;
          return "SENTINEL_pw";
        },
      });
      await throwOnce(hostile);
    } finally {
      Reflect.deleteProperty(Object.prototype, "value"); // 오염 창을 최소로 — 테스트 러너까지 물들이지 않는다
    }

    try {
      expect(polluted).toBe(false); // ★상속된 getter조차 부르지 않았다
      const [line] = con.lines();
      expect(typeof line).toBe("string");
      expect(line).not.toContain("SENTINEL_pw");
      expect(line).toContain("object");
    } finally {
      con.restore();
    }
  });

  test("진단은 죽지 않는다 — native Error의 message·code는 own 데이터라 그대로 남는다", async () => {
    // 접근자를 거절하는 규율이 진단까지 갉아먹지 않았는지 고정한다. 실측상 Bun의 native Error는
    // message·stack을 own *데이터* 프로퍼티로 들고 있고(접근자도 프로토타입도 아니다) 드라이버는 code를
    // own 데이터로 매단다 — 그래서 정상 에러는 손실 없이 그대로 찍힌다(로그는 stack까지 싣는다).
    const con = captureConsole();
    try {
      await throwOnce(Object.assign(new Error("queue unreachable"), { code: "ECONNRESET" }));

      const [line] = con.lines();
      expect(typeof line).toBe("string");
      expect(line).toContain("queue unreachable");
      expect(line).toContain("ECONNRESET");
      expect(line).toContain("at "); // stack 프레임 — 워커 로그는 사람이 보는 유일한 창이다
    } finally {
      con.restore();
    }
  });

  test("무엇이 던져지든 죽지 않고, 값이 아니라 타입으로 떨어진다", async () => {
    // 구멍은 매번 "우리가 세어보지 못한 모양"에서 났다. 그래서 모양을 세는 대신 규율을 고정한다:
    // 무엇이 던져져도 (1) 루프는 죽지 않고 (2) 줄은 문자열이며 (3) 매달린 값도 훅 반환값도 나오지 않고
    // (4) 남의 코드는 한 줄도 돌지 않는다(hookRan). 새 모양이 생겨도 이 표에 없을 뿐 결과는 같다 —
    // 기본값이 "타입만"이고, 읽기는 데이터 서술자만 채택하기 때문이다.
    const con = captureConsole();
    let hookRan = false;
    const leak = () => {
      hookRan = true;
      return "SENTINEL_pw";
    };
    const withGetter = <T extends object>(base: T, key: "message" | "code" | "stack"): T =>
      Object.defineProperty(base, key, { get: leak });

    const bait = { client: { password: "SENTINEL_pw" }, [Symbol.toPrimitive]: () => "SENTINEL_hook" };
    const { proxy: revokedObj, revoke: revokeObj } = Proxy.revocable({ client: { password: "SENTINEL_pw" } }, {});
    revokeObj();
    const { proxy: revokedFn, revoke: revokeFn } = Proxy.revocable(() => {}, {});
    revokeFn(); // typeof는 트랩을 거치지 않는다 — 해지된 함수 Proxy도 "function"으로 떨어진다.

    const cases: [unknown, string][] = [
      [null, "null"],
      [undefined, "undefined"],
      ["just a string", "just a string"], // 원시 문자열은 문자열화가 필요 없다 — 그대로 보여준다.
      [42, "42"],
      [true, "true"],
      [10n, "10"],
      [Symbol("s"), "symbol"], // 보간했다면 TypeError로 죽는다 — 그래서 symbol은 원시값 분기에 없다.
      [Object.assign(Object.create(null), { client: { password: "SENTINEL_pw" } }), "object"], // toString이 아예 없다 — String()이었다면 TypeError.
      [Object.assign(() => {}, bait), "function"], // 성공하는 Symbol.toPrimitive를 단 호출 가능한 값
      [withGetter(Object.assign(() => {}, { client: { password: "SENTINEL_pw" } }), "message"), "function"], // 성공하는 get message()
      [Object.assign(() => {}, { client: { password: "SENTINEL_pw" }, toString: () => "SENTINEL_hook" }), "function"],
      [Object.assign(() => {}, { message: "SENTINEL_pw" }), "function"], // ★own '데이터'여도 함수의 필드는 읽지 않는다(타입 가드가 빠지면 여기서 샌다)
      [withGetter({ client: { password: "SENTINEL_pw" } }, "message"), "object"], // 성공하는 get message()
      [withGetter({ message: "benign message" }, "code"), "benign message"], // 성공하는 get code() — 거절, message는 살아남는다
      [withGetter({ message: "benign message" }, "stack"), "benign message"], // 성공하는 get stack() — 거절, message로 떨어진다
      [{ get message(): string { throw new Error("boom"); } }, "object"], // 읽는 것 자체가 던진다
      [revokedObj, "object"], // 해지된 Proxy — 모든 접근이 던진다
      [revokedFn, "function"], // 해지된 함수 Proxy — 타입으로 먼저 떨어진다(서술자 훅에 닿지도 않는다)
      [new Proxy({ client: { password: "SENTINEL_pw" } }, { get: () => leak() }), "object"], // get 트랩은 돌지 않는다
      // 아래 5줄 — own '데이터'인데 값이 문자열이 아닌 경우다. 접근자가 아니라서 서술자 규율(hasOwn(d,"value"))을
      // 그대로 통과한다 — ownString의 문자열 검사가 own 데이터와 보간 사이의 유일한 관문이고, 그게 빠지면
      // 이 객체들이 errLine의 템플릿에 그대로 실려 매달린 훅이 돈다(=부르지 않기로 한 바로 그 남의 코드).
      [{ message: { toString: leak } }, "object"], // 보간(ToString)이 toString을 부른다
      [{ message: { [Symbol.toPrimitive]: leak } }, "object"], // toString보다 먼저 불린다(ToPrimitive의 첫 관문)
      [{ message: Object.assign(Object.create(null), { valueOf: leak }) }, "object"], // toString이 *없어야* valueOf까지 내려간다(있으면 "[object Object]"에서 멈춘다)
      [{ stack: { toString: leak }, message: "benign stack shadow" }, "benign stack shadow"], // stack이 먼저 읽히는 자리 — 거절되고 message로 떨어진다
      [Object.assign(new Error("own data code"), { code: { toString: leak } }), "own data code"], // pg가 code를 own 데이터로 매다는 바로 그 자리
      [new Error("native error message"), "native error message"], // ★진단 보존 — own 데이터 문자열은 그대로 나온다
    ];

    try {
      for (const [e] of cases) await expect(throwOnce(e)).resolves.toBeUndefined(); // 워커는 매번 살아남는다

      const lines = con.lines();
      expect(lines).toHaveLength(cases.length); // 삼키되 침묵하지 않는다 — 실패마다 한 줄
      expect(hookRan).toBe(false); // ★남의 코드는 한 줄도 돌지 않았다.
      cases.forEach(([, expected], i) => {
        expect(typeof lines[i]).toBe("string"); // ★e를 그대로 넘겼다면 여기서 죽는다
        expect(lines[i]).toContain(expected);
        expect(lines[i]).not.toContain("SENTINEL");
      });
    } finally {
      con.restore();
    }
  });
});
