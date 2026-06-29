// 백그라운드 워커 — http 비서빙. SIGTERM에 정상 종료(차트 terminationGracePeriod 내).
export {}; // top-level await 사용 → ESM 모듈로 표시(tsc TS1375)
let running = true;
process.on("SIGTERM", () => {
  running = false;
});

console.log("worker started");
while (running) {
  // TODO: 작업 단위(큐 소비/주기 작업 등)
  console.log("tick", new Date().toISOString());
  await Bun.sleep(5000);
}
console.log("worker stopped");
