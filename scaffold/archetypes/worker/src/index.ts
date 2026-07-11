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

console.log("worker started");
while (running) {
  let delay = INTERVAL_MS;
  try {
    // TODO: 작업 단위(큐 소비/주기 작업 등)
    console.log("tick", new Date().toISOString());
  } catch (e) {
    // 일시 오류가 프로세스를 즉사시키지 않게 흡수한다. 치명/일시 분류는 작업을 채우는 쪽의 몫.
    console.error("tick failed", e);
    delay = BACKOFF_MS;
  }
  await sleep(delay);
}
console.log("worker stopped");
process.exit(0);
