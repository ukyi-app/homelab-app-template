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

// 풀 error(=pg가 올려주는 임의의 남의 값)에서 로그 한 줄을 만든다 — ★던지지 않고, ★값을 문자열로 바꾸지 않는다.
// 규율은 허용목록이다: 안전하다고 *확인한* 조각만 줄에 넣고, 확인 못 한 건 값이 아니라 타입만 남긴다.
// ★왜 허용목록인가 — 위험한 모양을 하나씩 막는 블록리스트는 매번 새 구멍이 났다(콘솔의 객체 펼침 →
//   throw null → 던지는 getter → toPrimitive를 매단 *함수*). 구멍은 늘 "우리가 세어보지 못한 모양"이었다.
//   확인된 문자열 말고는 줄에 들어갈 길이 없으면, 세어보지 못한 모양이 와도 타입 이름으로 떨어질 뿐이다.
// ★왜 문자열화가 금지인가 — String()·toString·Symbol.toPrimitive·템플릿 보간·콘솔의 객체 펼침은 전부
//   "남의 코드 실행"이다. 그 코드는 (a) 던져서 프로세스를 죽이거나(리스너는 emit 스택 위에서 도니 여기서
//   터진 예외는 그대로 프로세스로 올라간다 — 이 리스너가 막으려던 바로 그 죽음) (b) 값에 매달린 자격증명을
//   흘린다(실측: pg는 err에 Client를 매달아 DB password를 평문으로 들고 있다).
//   (worker/src/index.ts가 같은 규율을 쓴다 — 아키타입은 앱당 하나만 복사되니 각자 자기 것을 갖는다.)
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
    // 그 외는 타입만 남긴다 — 사람이 "뭔가 올라왔으니 가서 보라"를 알기엔 충분하고, 매달린 값은 샐 자리가 없다.
    const own =
      typeof e === "string"
        ? e
        : typeof e === "number" || typeof e === "boolean" || typeof e === "bigint"
          ? `${e}`
          : `(읽을 수 있는 message·stack 없음: ${e === null ? "null" : typeof e})`;
    return `pg pool error (code=${field("code") ?? "none"}): ${field("stack") ?? field("message") ?? own}`;
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
