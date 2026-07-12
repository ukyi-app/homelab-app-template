// 백그라운드 워커 — http 비서빙. SIGTERM에 정상 종료(차트 terminationGracePeriod 내).
export {}; // top-level await 사용 → ESM 모듈로 표시(tsc TS1375)

const INTERVAL_MS = 5000;
const BACKOFF_MS = 1000; // 일시 오류 후 재시도까지 — 실패가 반복돼도 busy-loop이 되지 않게

let running = true;
// 슬롯 하나 = 동시에 잠든 sleep()이 최대 하나라는 전제. 아래 순차 루프가 유일한 호출부다.
let wake: (() => void) | undefined;

// distroless에서 앱은 PID 1 — 핸들러 없는 시그널은 커널이 기본 종료시키지 않고 무시한다.
const shutdown = () => {
  running = false;
  wake?.(); // 남은 주기를 다 기다리면 유예시간을 태운다.
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// 중단 가능한 sleep — Bun.sleep()은 abort를 받지 못한다. 타이머와 종료 신호를 경합시키되,
// 어느 쪽이 이기든 타이머를 해제해 이벤트 루프에 잔여 핸들이 남지 않게 한다.
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    if (!running) return resolve(); // 작업 중 시그널이 왔다면 여기서 자는 순간 한 주기를 태운다.
    const done = () => {
      clearTimeout(timer);
      wake = undefined;
      resolve();
    };
    const timer = setTimeout(done, ms);
    wake = done;
  });

// throw된 값에서 로그 한 줄을 만든다 — ★이 함수는 무슨 일이 있어도 던지지 않는다.
// ★에러 객체를 콘솔에 그대로 넘기지 않는다 — 콘솔이 객체를 펼치면 거기 매달린 자격증명까지 찍힌다
//   (실측: pg는 err에 Client를 매달아 DB password를 평문으로 흘린다 — api의 src/db.ts가 같은 이유로 같은 규율을 쓴다).
//   아래 TODO가 DB·SDK 호출로 채워지는 순간 그 유출이 중앙 로그로 간다. 그래서 허용 필드(code·stack·message)만,
//   그것도 문자열일 때만 읽는다(객체를 절대 펼치지 않으니 매달린 값이 샐 자리가 없다).
// ★throw된 값이 Error라는 보장이 없다(throw null·throw "문자열"·await Promise.reject()) — 단언 뒤 구조분해하면
//   그 구조분해가 catch 안에서 터진다. 그래서 단언이 아니라 런타임으로 좁힌다.
// ★필드를 "읽는 것" 자체도 던질 수 있다(throw하는 getter, 해지된 Proxy). catch 안에서 그게 터지면 예외가 catch를
//   뚫고 나가 백오프를 건너뛰고 워커를 죽인다 — 이 try/catch가 막으려던 바로 그 죽음이다. 그래서 프로퍼티 접근과
//   문자열화를 전부 여기 가둔다: 무엇이 던져지든 상수 문자열로 떨어질 뿐, 루프 밖으로는 아무것도 새지 않는다.
const errLine = (e: unknown): string => {
  const read = (key: string): string | undefined => {
    try {
      const v = (e as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined; // 문자열이 아니면 없는 셈 친다 — 객체면 펼쳐야 하니까.
    } catch {
      return undefined; // getter·Proxy가 폭발했다 — 이 필드만 포기하고 나머지로 계속한다.
    }
  };
  try {
    if (typeof e !== "object" || e === null) return `tick failed (code=none): ${String(e)}`; // 원시값 — 매달린 값이 없다.
    return `tick failed (code=${read("code") ?? "none"}): ${read("stack") ?? read("message") ?? "(읽을 수 있는 message·stack 없음)"}`;
  } catch {
    // 최후 방어선 — String()도 던질 수 있다(해지된 *함수* Proxy는 typeof가 "function"이라 위 원시값 분기로 샌다).
    return "tick failed (code=?): (읽을 수 없는 throw 값)";
  }
};

console.log("worker started");
while (running) {
  let delay = INTERVAL_MS;
  try {
    // TODO: 작업 단위(큐 소비/주기 작업 등)
    console.log("tick", new Date().toISOString());
  } catch (e) {
    // 일시 오류가 프로세스를 즉사시키지 않게 흡수한다. 치명/일시 분류는 작업을 채우는 쪽의 몫.
    console.error(errLine(e)); // ★e를 그대로 넘기지 않는다 — errLine이 만든 문자열 하나만 넘긴다.
    delay = BACKOFF_MS;
  }
  await sleep(delay);
}
console.log("worker stopped");
process.exit(0);
