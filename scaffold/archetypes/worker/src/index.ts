// 백그라운드 워커 — http 비서빙. SIGTERM에 정상 종료(차트 terminationGracePeriod 내).

const INTERVAL_MS = 5000;
const BACKOFF_MS = 1000; // 일시 오류 후 재시도까지 — 실패가 반복돼도 busy-loop이 되지 않게
// ★선언에 export를 붙이지 않는다 — template-ci의 worker 스모크 가드가 `^const INTERVAL_MS = <숫자>;`를
//   sed로 읽어 SIGTERM 판별 마진(주기 ≥ 5s)을 단언한다. 선언 형태가 바뀌면 그 가드가 값을 못 읽는다.
export { INTERVAL_MS, BACKOFF_MS };

// 프로퍼티를 *데이터로만* 읽는다 — 남의 코드를 부르지 않는다.
// ★왜 e[key]가 아닌가 — e[key]는 읽기가 아니라 *호출*이다(getter·Proxy get 트랩). 던지는 getter는 try로
//   막았지만 *성공하는* getter는 그대로 신뢰됐고, get message(){ return this.client.password } 하나로
//   password가 로그에 앉았다. 경계는 "던지느냐"가 아니라 "부르느냐"다 — 그래서 부르지 않는다.
// ★getOwnPropertyDescriptor는 값을 평가하지 않는다: 데이터면 value를 그대로 주고, 접근자면 get *함수*를
//   건네줄 뿐 실행하지 않는다. 그래서 데이터 서술자만 채택하면 성공하는 getter조차 돌 기회가 없다.
// ★hasOwn을 쓰는 이유("value" in d가 아니라) — 서술자의 프로토타입은 Object.prototype이다. 누가
//   Object.prototype.value에 getter를 심어 두면 접근자 서술자에서도 in이 true가 되고, 이어지는 d.value가
//   그 상속 getter를 부른다(=막으려던 바로 그것). hasOwn은 체인을 보지 않는다.
// ★try가 남는 이유 — Proxy는 getOwnPropertyDescriptor 훅 자체를 가로채 던질 수 있다.
// ★실측(Bun) — native Error의 message·stack은 own *데이터* 프로퍼티다(stack은 프로토타입도 접근자도 아니다).
//   code는 pg가 own 데이터로 매단다. 그래서 이 규율로도 진단이 죽지 않는다.
// ★데이터 서술자라고 다 문자열은 아니다 — throw { message: { toString: () => password } }의 message는
//   접근자가 아니라 own *데이터*다(값이 객체일 뿐). 문자열 검사를 빼면 그 객체가 그대로 errLine의 템플릿
//   보간에 실려 toString·valueOf·Symbol.toPrimitive가 돈다 — 접근자를 막고도 같은 구멍이 다시 열린다.
//   그래서 문자열 검사가 own 데이터와 보간 사이의 마지막 관문이다(표가 이걸 고정한다).
// ★unknown으로 한 번 받는 이유 — PropertyDescriptor.value는 any다. any에 건 typeof는 컴파일러에겐
//   아무것도 좁히지 않는 참이라 `string | undefined`라는 반환 타입이 거짓말이 되고, 검사를 지워도 tsc는
//   조용하다. unknown으로 받으면 typeof가 진짜 내로잉이 된다 — 검사를 지우는 순간 타입체크부터 빨개진다.
const ownString = (o: object, key: "code" | "message" | "stack"): string | undefined => {
  try {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !Object.hasOwn(d, "value")) return undefined;
    const v: unknown = d.value;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
};

// throw된 값(=임의의 남의 값)에서 로그 한 줄을 만든다 — ★던지지 않고, ★남의 코드를 부르지 않는다.
// 규율은 "무엇을 쓰나"(허용목록)가 아니라 "어떻게 읽나"다. 허용목록만으론 부족했다: 허용된 필드라도
// 읽는 방식이 호출이면 남의 코드는 그대로 돈다. 그래서 두 겹으로 잠근다 —
//   (1) 평범한 객체가 아니면(함수·심볼·원시값) 필드를 읽기 *전에* 타입으로 떨어뜨린다.
//   (2) 읽을 땐 서술자로만 읽고, 데이터로 놓인 문자열만 채택한다(접근자는 호출하지 않고 거절).
// ★문자열화도 같은 이유로 금지다 — String()·toString·Symbol.toPrimitive·템플릿 보간·콘솔의 객체 펼침은
//   전부 남의 코드 실행이다. 그 코드는 (a) 던져서 이 catch를 뚫고 워커를 죽이거나 (b) 값에 매달린 자격증명을
//   흘린다(실측: pg는 err에 Client를 매달아 DB password를 평문으로 들고 있다 — 아래 TODO가 DB·SDK
//   호출로 채워지는 순간 그게 중앙 로그로 간다. api의 src/db.ts가 같은 이유로 같은 규율을 쓴다).
// ★이 규율은 src/index.test.ts의 타입 표가 고정한다 — 훅이 '돌지 않았다'까지(반환값 검사가 아니라 호출 금지).
const errLine = (e: unknown): string => {
  const noDetail = (t: string) => `(읽을 수 있는 message·stack 없음: ${t})`;
  try {
    // 원시값만 값 자체를 보여준다 — number·boolean·bigint의 ToString은 스펙 내부 연산이라 프로토타입도
    // 훅도 거치지 않는다(symbol은 보간하면 TypeError로 죽으므로 이 분기에 없다).
    if (typeof e === "string") return `tick failed (code=none): ${e}`;
    if (typeof e === "number" || typeof e === "boolean" || typeof e === "bigint") return `tick failed (code=none): ${e}`;
    // ★필드를 읽을 자격은 평범한 객체에만 준다 — 호출 가능한 값에 get message()를 달아 password를 흘린 게
    //   R-9다. 함수·심볼·undefined·null은 읽기 전에 타입으로 떨어뜨린다: 읽지 않으면 부를 일도 없다.
    if (e === null) return `tick failed (code=none): ${noDetail("null")}`;
    if (typeof e !== "object") return `tick failed (code=none): ${noDetail(typeof e)}`;
    // stack이 우선 — Bun의 stack은 "Error: <message>" 머리를 포함한다(실측). 둘 다 없으면 타입만.
    return `tick failed (code=${ownString(e, "code") ?? "none"}): ${ownString(e, "stack") ?? ownString(e, "message") ?? noDetail("object")}`;
  } catch {
    // 도달 불가여야 한다(위 조각은 전부 확인된 문자열이다). 그래도 남긴다 — 여기서 던지면 백오프를 건너뛰고
    // 워커가 죽는다. 이 try/catch가 막으려던 바로 그 죽음이다.
    return "tick failed (code=?): (로그 조립 실패)";
  }
};

// 주기 작업 한 단위 — TODO: 여기를 채운다(큐 소비/주기 작업 등).
const tick = () => {
  console.log("tick", new Date().toISOString());
};

// 워커 하나 = 상태 하나(running·wake). 모듈 최상단에서 while을 돌리지 않고 팩토리로 감싼 이유 —
//   (1) 기동이 값이 되어야 import.meta.main 뒤로 미룰 수 있다. import만으로 루프가 돌면 테스트가 곧 워커다
//       (그래서 이 아키타입엔 테스트가 0개였다 — 포매터의 다섯 라운드짜리 읽기 규율이 무방비였다).
//   (2) 상태가 모듈 전역이면 테스트끼리 물려받는다 — 한 번 멈춘 워커는 다음 테스트에서 이미 멈춰 있다.
// ★work를 파라미터로 받는다 — 주입된 work도 아래 try/catch·백오프를 우회하지 못한다. 테스트가 errLine을
//   직접 부르는 대신 이 경로로 던져야 `console.error(e)`로 되돌아가는 회귀까지 잡힌다(무엇을 넘겼나가 핵심).
export function createWorker(work: () => unknown = tick) {
  let running = true;
  // 슬롯 하나 = 동시에 잠든 sleep()이 최대 하나라는 전제. 아래 순차 루프가 유일한 호출부다.
  let wake: (() => void) | undefined;

  // 종료 신호. 시그널 핸들러도 테스트도 이 한 지점으로 수렴한다.
  const stop = () => {
    running = false;
    wake?.(); // 남은 주기를 다 기다리면 유예시간을 태운다.
  };

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

  const run = async (): Promise<void> => {
    console.log("worker started");
    while (running) {
      let delay = INTERVAL_MS;
      try {
        await work();
      } catch (e) {
        // 일시 오류가 프로세스를 즉사시키지 않게 흡수한다. 치명/일시 분류는 작업을 채우는 쪽의 몫.
        console.error(errLine(e)); // ★e를 그대로 넘기지 않는다 — errLine이 만든 문자열 하나만 넘긴다.
        delay = BACKOFF_MS;
      }
      await sleep(delay);
    }
    console.log("worker stopped");
  };

  return { run, stop };
}

// 엔트리 가드 — 루프는 직접 실행할 때만 돈다(테스트가 import해도 워커가 되지 않는다).
if (import.meta.main) {
  const worker = createWorker();
  // distroless에서 앱은 PID 1 — 핸들러 없는 시그널은 커널이 기본 종료시키지 않고 무시한다.
  process.on("SIGTERM", worker.stop);
  process.on("SIGINT", worker.stop);
  await worker.run();
  process.exit(0);
}
