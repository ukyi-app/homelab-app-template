import { Pool, type PoolConfig } from "pg";

// 풀러-안전 pg Pool 설정.
// ★statement_timeout을 startup 파라미터로 보내지 않는다 — homelab 공유 풀러(PgBouncer transaction
//   모드)는 startup GUC를 거부한다. 대신 client-side query_timeout(node-pg가 N ms 후 쿼리를 취소)과
//   connectionTimeoutMillis만 쓴다 — 둘 다 프로토콜 startup 파라미터가 아니다. 서버측 강제가 필요하면
//   롤 레벨 grant로(ALTER ROLE 으로 statement_timeout 설정; 앱 startup 파라미터가 아니라).
export function buildPoolConfig(connectionString: string): PoolConfig {
  return { connectionString, max: 3, connectionTimeoutMillis: 5_000, query_timeout: 5_000 };
}

export function createPool(connectionString: string): Pool {
  return new Pool(buildPoolConfig(connectionString));
}

// homelab conn SealedSecret은 <APP>_DATABASE_URL / <APP>_MIGRATE_DATABASE_URL / <APP>_RO_DATABASE_URL
// 형태로 env를 주입한다(provision-db 규약). 앱 이름을 몰라도 되도록 접미사로 자동 발견하되, 접두사 없는
// generic DATABASE_URL이 있으면 그쪽이 우선한다(접미사 매칭은 generic이 없을 때만 돈다).
// 런타임 URL은 MIGRATE_/RO_ 키를 제외한다.
type Env = Record<string, string | undefined>;

function discover(env: Env, suffix: string, exclude: string[]): string | undefined {
  if (env[suffix]) return env[suffix];
  const key = Object.keys(env).find(
    (k) => k.endsWith(`_${suffix}`) && !exclude.some((x) => k.endsWith(x)),
  );
  return key ? env[key] : undefined;
}

// env를 주입받는 순수 함수 — 프로세스 환경을 흔들지 않고 발견 규칙을 단위 테스트할 수 있다.
export function runtimeUrl(env: Env = process.env): string | undefined {
  return discover(env, "DATABASE_URL", ["_MIGRATE_DATABASE_URL", "_RO_DATABASE_URL"]);
}

// DB가 설정되지 않은 앱(무DB)이면 null — readiness가 정적으로 통과하도록.
export function createRuntimePool(): Pool | null {
  const url = runtimeUrl();
  return url ? createPool(url) : null;
}

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
//   code는 pg가 own 데이터로 매단다(57P01·ECONNRESET). 그래서 이 규율로도 진단이 죽지 않는다.
// ★내보내는 이유 — 이 아키타입 안에서 읽기 규율의 구현은 여기 하나뿐이어야 한다. index.ts(/readyz 503 본문)도
//   이걸 import한다. 복제해 두면 한쪽만 굳고(다섯 라운드: 객체 펼침 → 강제변환 훅 → 던지는 접근자 → 성공하는
//   접근자) 손대지 않은 쪽에서 그 구멍이 조용히 다시 열린다. 반대로 아키타입을 *가로지르는* 공유 모듈은 만들지
//   않는다 — 앱엔 아키타입 하나만 복사되므로 worker는 자기 것을 갖는다.
// ★공유하는 건 *읽기*뿐이다 — 포매터는 싱크마다 다르다(로그는 stack을 싣고, 503 본문은 싣지 않는다).
export const ownString = (o: object, key: "code" | "message" | "stack"): string | undefined => {
  try {
    const d = Object.getOwnPropertyDescriptor(o, key);
    return d && Object.hasOwn(d, "value") && typeof d.value === "string" ? d.value : undefined;
  } catch {
    return undefined;
  }
};

// 풀 error(=pg가 올려주는 임의의 남의 값)에서 로그 한 줄을 만든다 — ★던지지 않고, ★남의 코드를 부르지 않는다.
// 규율은 "무엇을 쓰나"(허용목록)가 아니라 "어떻게 읽나"다. 허용목록만으론 부족했다: 허용된 필드라도
// 읽는 방식이 호출이면 남의 코드는 그대로 돈다. 그래서 두 겹으로 잠근다 —
//   (1) 평범한 객체가 아니면(함수·심볼·원시값) 필드를 읽기 *전에* 타입으로 떨어뜨린다.
//   (2) 읽을 땐 서술자로만 읽고, 데이터로 놓인 문자열만 채택한다(접근자는 호출하지 않고 거절).
// ★문자열화도 같은 이유로 금지다 — String()·toString·Symbol.toPrimitive·템플릿 보간·콘솔의 객체 펼침은
//   전부 남의 코드 실행이다. 그 코드는 (a) 던져서 프로세스를 죽이거나(리스너는 emit 스택 위에서 도니 여기서
//   터진 예외는 그대로 프로세스로 올라간다 — 이 리스너가 막으려던 바로 그 죽음) (b) 값에 매달린 자격증명을
//   흘린다(실측: pg는 err에 Client를 매달아 DB password를 평문으로 들고 있다).
// ★이 포매터는 로그용이라 stack을 싣는다 — 네트워크로 나가는 /readyz 503 본문(index.ts)은 싣지 않는다.
const errLine = (e: unknown): string => {
  const noDetail = (t: string) => `(읽을 수 있는 message·stack 없음: ${t})`;
  try {
    // 원시값만 값 자체를 보여준다 — number·boolean·bigint의 ToString은 스펙 내부 연산이라 프로토타입도
    // 훅도 거치지 않는다(symbol은 보간하면 TypeError로 죽으므로 이 분기에 없다).
    if (typeof e === "string") return `pg pool error (code=none): ${e}`;
    if (typeof e === "number" || typeof e === "boolean" || typeof e === "bigint") return `pg pool error (code=none): ${e}`;
    // ★필드를 읽을 자격은 평범한 객체에만 준다 — 호출 가능한 값에 get message()를 달아 password를 흘린 게
    //   R-9다. 함수·심볼·undefined·null은 읽기 전에 타입으로 떨어뜨린다: 읽지 않으면 부를 일도 없다.
    if (e === null) return `pg pool error (code=none): ${noDetail("null")}`;
    if (typeof e !== "object") return `pg pool error (code=none): ${noDetail(typeof e)}`;
    // stack이 우선 — Bun의 stack은 "Error: <message>" 머리를 포함한다(실측). 둘 다 없으면 타입만.
    return `pg pool error (code=${ownString(e, "code") ?? "none"}): ${ownString(e, "stack") ?? ownString(e, "message") ?? noDetail("object")}`;
  } catch {
    // 도달 불가여야 한다(위 조각은 전부 확인된 문자열이다). 그래도 남긴다 — 여기서 던지면 프로세스가 죽는다.
    return "pg pool error (code=?): (로그 조립 실패)";
  }
};

// 풀 준비 — 풀을 쓰기 전 반드시 통과하는 한 지점. 등록이 곧 계약이라 반환값이 없다.
// ★error 리스너는 여기에만 둔다. 풀러 재시작·cnpg 페일오버·네트워크 파티션은 유휴 커넥션의 'error'로
//   올라오는데, 리스너가 없으면 그 순단이 로그 한 줄 없이 사라진다(pg 계약상 unhandled 'error'는 throw이나
//   현재 Bun은 이 throw를 삼킨다 — 미명세 동작이라 베이스 이미지가 올라가면 죽을 수도 있다).
// ★code를 함께 찍는다 — 풀러 축출(57P01)인지 TCP 리셋(ECONNRESET)인지가 진단을 가른다.
//   삼키되 죽지 않는다 — liveness는 정적, 순단은 다음 readiness 왕복에서 503 → 재연결로 수렴한다.
export function preparePool(pool: Pool | null): void {
  pool?.on("error", (e) => {
    console.error(errLine(e)); // ★e를 그대로 넘기지 않는다 — errLine이 만든 문자열 하나만 넘긴다.
  });
}
