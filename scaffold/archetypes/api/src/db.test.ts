import { describe, expect, test } from "bun:test";
import { runtimeUrl } from "./db";

// provision-db env 계약(<APP>_DATABASE_URL / _MIGRATE_ / _RO_)의 회귀 방어선 —
// 접미사가 어긋나거나 MIGRATE/RO 풀이 새어 들어오면 런타임이 잘못된 롤로 붙는다.
describe("runtimeUrl", () => {
  test("접미사로 앱 런타임 URL을 자동 발견", () => {
    expect(runtimeUrl({ MYAPP_DATABASE_URL: "postgres://rw" })).toBe("postgres://rw");
  });

  test("MIGRATE_/RO_ 키만 있으면 런타임 URL은 없다", () => {
    const env = {
      MYAPP_MIGRATE_DATABASE_URL: "postgres://migrate",
      MYAPP_RO_DATABASE_URL: "postgres://ro",
    };
    expect(runtimeUrl(env)).toBeUndefined();
  });

  test("MIGRATE_/RO_와 섞여 있어도 런타임 키만 고른다", () => {
    const env = {
      MYAPP_MIGRATE_DATABASE_URL: "postgres://migrate",
      MYAPP_DATABASE_URL: "postgres://rw",
      MYAPP_RO_DATABASE_URL: "postgres://ro",
    };
    expect(runtimeUrl(env)).toBe("postgres://rw");
  });

  test("접두사 없는 generic DATABASE_URL을 그대로 쓴다", () => {
    expect(runtimeUrl({ DATABASE_URL: "postgres://generic" })).toBe("postgres://generic");
  });

  test("generic DATABASE_URL이 접두사 키보다 우선한다(fallback이 아니다)", () => {
    const env = { DATABASE_URL: "postgres://generic", MYAPP_DATABASE_URL: "postgres://rw" };
    expect(runtimeUrl(env)).toBe("postgres://generic");
  });

  test("DB 미설정 앱이면 undefined", () => {
    expect(runtimeUrl({ PATH: "/usr/bin", PORT: "8080" })).toBeUndefined();
  });
});
