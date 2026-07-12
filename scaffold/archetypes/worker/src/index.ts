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

// throw된 값(=임의의 남의 값)에서 로그 한 줄을 만든다 — ★던지지 않고, ★값을 문자열로 바꾸지 않는다.
// 규율은 허용목록이다: 안전하다고 *확인한* 조각만 줄에 넣고, 확인 못 한 건 값이 아니라 타입만 남긴다.
// ★왜 허용목록인가 — 위험한 모양을 하나씩 막는 블록리스트는 매번 새 구멍이 났다(콘솔의 객체 펼침 →
//   throw null → 던지는 getter → toPrimitive를 매단 *함수*). 구멍은 늘 "우리가 세어보지 못한 모양"이었다.
//   확인된 문자열 말고는 줄에 들어갈 길이 없으면, 세어보지 못한 모양이 와도 타입 이름으로 떨어질 뿐이다.
// ★왜 문자열화가 금지인가 — String()·toString·Symbol.toPrimitive·템플릿 보간·콘솔의 객체 펼침은 전부
//   "남의 코드 실행"이다. 그 코드는 (a) 던져서 이 catch를 뚫고 워커를 죽이거나 (b) 값에 매달린 자격증명을
//   흘린다(실측: pg는 err에 Client를 매달아 DB password를 평문으로 들고 있다 — 아래 TODO가 DB·SDK
//   호출로 채워지는 순간 그게 중앙 로그로 간다. api의 src/db.ts가 같은 이유로 같은 규율을 쓴다).
const errLine = (e: unknown): string => {
  // 허용 필드만, 그것도 *이미* 문자열일 때만 채택한다(문자열이 아닌 걸 살리려면 문자열화해야 하니까).
  // 읽는 것 자체가 던질 수 있어(던지는 getter·해지된 Proxy) 읽기를 가둔다 — 한 필드가 터져도 그 필드만 버린다.
  const field = (key: "code" | "message" | "stack"): string | undefined => {
    try {
      const v = (e as Record<string, unknown>)[key];
      return typeof v === "string" ? v : undefined;
    } catch {
      return undefined;
    }
  };
  try {
    // 값 자체를 보여줄 수 있는 건 원시값뿐이다. number·boolean·bigint의 ToString은 스펙 내부 연산이라
    // 프로토타입도 훅도 거치지 않는다(symbol은 던지고, 객체·함수는 훅을 부르므로 이 분기에 못 온다).
    // 그 외는 타입만 남긴다 — 사람이 "뭔가 던져졌으니 가서 보라"를 알기엔 충분하고, 매달린 값은 샐 자리가 없다.
    const own =
      typeof e === "string"
        ? e
        : typeof e === "number" || typeof e === "boolean" || typeof e === "bigint"
          ? `${e}`
          : `(읽을 수 있는 message·stack 없음: ${e === null ? "null" : typeof e})`;
    return `tick failed (code=${field("code") ?? "none"}): ${field("stack") ?? field("message") ?? own}`;
  } catch {
    // 도달 불가여야 한다(위 조각은 전부 확인된 문자열이다). 그래도 남긴다 — 여기서 던지면 백오프를 건너뛰고
    // 워커가 죽는다. 이 try/catch가 막으려던 바로 그 죽음이다.
    return "tick failed (code=?): (로그 조립 실패)";
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
