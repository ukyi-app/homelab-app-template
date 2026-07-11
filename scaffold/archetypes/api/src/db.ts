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
