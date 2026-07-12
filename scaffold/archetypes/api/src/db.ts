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

// 풀 error에서 로그 한 줄을 만든다 — ★이 함수는 무슨 일이 있어도 던지지 않는다.
// ★에러 객체를 콘솔에 그대로 넘기지 않는다 — 콘솔이 객체를 펼치면 pg가 err에 매달아 둔 Client까지 찍혀
//   DB password가 평문으로 흐른다(실측). 그래서 허용 필드(code·stack·message)만, 그것도 문자열일 때만
//   읽는다 — 객체를 절대 펼치지 않으니 매달린 값이 샐 자리가 없다.
// ★필드를 "읽는 것" 자체가 던질 수 있다(throw하는 getter, 해지된 Proxy). 리스너는 emit 스택 위에서 도니까
//   여기서 터진 예외는 그대로 프로세스로 올라간다 — 이 리스너가 막으려던 바로 그 죽음이다. 그래서 프로퍼티
//   접근과 문자열화를 전부 여기 가둔다: 무엇이 올라오든 상수 문자열로 떨어질 뿐 밖으로는 아무것도 새지 않는다.
//   (worker/src/index.ts가 같은 규율을 쓴다 — 아키타입은 앱당 하나만 복사되니 각자 자기 것을 갖는다.)
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
    if (typeof e !== "object" || e === null) return `pg pool error (code=none): ${String(e)}`; // 원시값 — 매달린 값이 없다.
    return `pg pool error (code=${read("code") ?? "none"}): ${read("stack") ?? read("message") ?? "(읽을 수 있는 message·stack 없음)"}`;
  } catch {
    // 최후 방어선 — String()도 던질 수 있다(해지된 *함수* Proxy는 typeof가 "function"이라 위 원시값 분기로 샌다).
    return "pg pool error (code=?): (읽을 수 없는 error 값)";
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
