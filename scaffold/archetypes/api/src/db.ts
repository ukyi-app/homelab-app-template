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

// homelab conn SealedSecret은 <DB>_DATABASE_URL / <DB>_MIGRATE_DATABASE_URL / <DB>_RO_DATABASE_URL
// 형태로 env를 주입한다(provision-db 규약).
// ★<DB>는 앱 이름이 아니라 create-database에 준 *DB 이름*의 UPPER_SNAKE다(provision-db.ts:
//   name.replaceAll("-","_").toUpperCase()). 둘은 같을 의무가 없다 — 실제로 앱 trip-mate-api는 DB
//   trip-mate를 받아 키가 TRIP_MATE_DATABASE_URL이다. 그래서 접두사를 *추측하지 않고* 접미사로 발견한다:
//   앱이 자기 DB 이름을 몰라도 붙는다(그 이름을 코드에 박으면 DB를 옮길 때마다 앱이 깨진다).
// ★우선순위는 접두사 키다 — generic DATABASE_URL은 접두사 키가 하나도 없을 때만 쓰는 fallback이다
//   (generic은 homelab dev.ts가 로컬 Postgres에 쓰는 이름이다). 반대로 두면 개발자의 .env에 남은
//   DATABASE_URL이 봉인되어 파드까지 따라가 플랫폼이 주입한 진짜 URL을 가린다 — 프로덕션이 조용히
//   죽은 localhost나 엉뚱한 DB를 본다. 봉인 쪽(tools/seal-secret.mts)이 이 사실을 경고로 한 번 더 짚는다.
// ★_MIGRATE_/_RO_는 런타임 후보가 아니다 — 셋 다 같은 DB를 가리키지만 롤·호스트가 다르다(provision-db):
//   런타임은 owner 롤 + 풀러(pg-pooler-rw) 경유, _MIGRATE_는 *같은 owner 롤이지만 직결*(pg-rw — session
//   시맨틱이 필요해서), _RO_는 읽기전용 롤 + 직결(디버깅 전용, 앱에 배선하지 않는다). 그래서 _MIGRATE_가
//   런타임으로 새면 롤이 아니라 *풀러가* 빠진다 — 앱 풀이 공유 클러스터에 직결로 붙어 max_connections를 고갈시킨다.
//   접두사 자리에 역할 이름만 들어온 꼴(MIGRATE_DATABASE_URL·RO_DATABASE_URL)도 함께 뺀다 — 접두사가 이기게 된
//   순간 그게 generic을 이겨 같은 사고가 난다. 경계는 '_ 또는 문자열 시작'으로만 끊는다: DB 이름이 euro면
//   EURO_DATABASE_URL은 정상 키인데 단순 endsWith("RO_DATABASE_URL")는 그걸 삼킨다.
// ★후보가 둘 이상이면 던진다 — 어느 DB가 이 앱 것인지 아는 주체가 아무 데도 없다. Object.keys 순서
//   (=삽입 순서)로 조용히 하나를 고르면 엉뚱한 DB에 쓰고도 초록이고 되돌릴 수 없다. 기동에서 죽는 편이 낫다
//   (CrashLoop는 시끄럽고 되돌릴 수 있다). 플랫폼은 DB 하나당 접두사 키를 하나만 주입하므로, 둘이 보인다는 건
//   봉인한 .env의 DB URL 키가 끼어들었다는 뜻이다 — 외부 DB URL을 봉인해 둔 앱이 나중에 homelab DB까지
//   받으면 정확히 이 상태가 된다(seal-secret.mts의 경고가 미리 말하는 그 상태다).
// ★자동 발견으로 정할 수 없는 배치라면 이 함수를 우회한다 — 풀을 직접 만들어 createApp(pool)로 넘기면 된다
//   (index.ts: createApp(db: Pool | null = createRuntimePool())). 던지는 메시지도 그 탈출구를 가리킨다.
type Env = Record<string, string | undefined>;
const SUFFIX = "_DATABASE_URL";
const ROLE = /(^|_)(MIGRATE|RO)$/; // 접두사 부분이 역할 이름으로 끝나면 런타임 키가 아니다

// env를 주입받는 순수 함수 — 프로세스 환경을 흔들지 않고 발견 규칙을 단위 테스트할 수 있다.
export function runtimeUrl(env: Env = process.env): string | undefined {
  const keys = Object.keys(env)
    .filter((k) => k.endsWith(SUFFIX) && env[k] && !ROLE.test(k.slice(0, -SUFFIX.length)))
    .sort(); // 에러 메시지를 결정적으로 만든다(값 선택엔 쓰지 않는다 — 둘 이상이면 아래에서 죽는다)
  if (keys.length > 1) {
    throw new Error(
      `런타임 DB URL 후보가 여럿이다(${keys.join(", ")}) — 어느 것이 이 앱 것인지 정할 수 없어 기동을 멈춘다. ` +
        `소스를 하나로 줄여라: homelab이 프로비저닝한 DB를 쓴다면 플랫폼이 주입한 키만 남기고 직접 봉인한 DB URL 키를 .env에서 뺀다(로컬 URL은 .env.local로). ` +
        `외부 DB를 쓴다면 이 앱에 create-database를 돌리지 않는다. ` +
        `둘 다 의도한 배치라면 자동 발견을 쓰지 말고 풀을 직접 만들어 createApp(pool)로 넘겨라.`,
    );
  }
  return keys.length === 1 ? env[keys[0]] : env.DATABASE_URL || undefined;
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
// ★데이터 서술자라고 다 문자열은 아니다 — reject({ message: { toString: () => password } })의 message는
//   접근자가 아니라 own *데이터*다(값이 객체일 뿐). 문자열 검사를 빼면 그 객체가 그대로 포매터의 템플릿
//   보간에 실려 toString·valueOf·Symbol.toPrimitive가 돈다 — 접근자를 막고도 같은 구멍이 다시 열린다.
//   싱크가 로그만이 아니라서 더 아프다: notReadyBody(index.ts)를 타면 그 반환값이 /readyz 503 본문으로
//   네트워크에 나간다. 그래서 문자열 검사가 own 데이터와 보간 사이의 마지막 관문이다(표가 이걸 고정한다).
// ★unknown으로 한 번 받는 이유 — PropertyDescriptor.value는 any다. any에 건 typeof는 컴파일러에겐
//   아무것도 좁히지 않는 참이라 `string | undefined`라는 반환 타입이 거짓말이 되고, 검사를 지워도 tsc는
//   조용하다. unknown으로 받으면 typeof가 진짜 내로잉이 된다 — 검사를 지우는 순간 타입체크부터 빨개진다.
// ★내보내는 이유 — 이 아키타입 안에서 읽기 규율의 구현은 여기 하나뿐이어야 한다. index.ts(/readyz 503 본문)도
//   이걸 import한다. 복제해 두면 한쪽만 굳고(다섯 라운드: 객체 펼침 → 강제변환 훅 → 던지는 접근자 → 성공하는
//   접근자) 손대지 않은 쪽에서 그 구멍이 조용히 다시 열린다. 반대로 아키타입을 *가로지르는* 공유 모듈은 만들지
//   않는다 — 앱엔 아키타입 하나만 복사되므로 worker는 자기 것을 갖는다.
// ★공유하는 건 *읽기*뿐이다 — 포매터는 싱크마다 다르다(로그는 stack을 싣고, 503 본문은 싣지 않는다).
export const ownString = (o: object, key: "code" | "message" | "stack"): string | undefined => {
  try {
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !Object.hasOwn(d, "value")) return undefined;
    const v: unknown = d.value;
    return typeof v === "string" ? v : undefined;
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
