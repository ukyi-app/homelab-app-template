import { describe, expect, test } from "bun:test";
import { runtimeUrl } from "./db";

// provision-db env 계약(<DB>_DATABASE_URL / _MIGRATE_ / _RO_ — <DB>는 앱 이름이 아니라 DB 이름의
// UPPER_SNAKE다)의 회귀 방어선 — 접미사가 어긋나거나 MIGRATE/RO 풀이 새어 들어오면 런타임이 잘못된 롤로 붙는다.
// ★우선순위는 이 파일이 계약이다: 플랫폼이 주입한 접두사 키가 이기고, generic은 fallback이다.
//   뒤집히면 .env에 남은 DATABASE_URL이 봉인되어 프로덕션 URL을 가린다(조용히 엉뚱한 DB).
describe("runtimeUrl", () => {
  test("접미사로 앱 런타임 URL을 자동 발견", () => {
    expect(runtimeUrl({ MYAPP_DATABASE_URL: "postgres://rw" })).toBe("postgres://rw");
  });

  test("접두사 키가 generic DATABASE_URL을 이긴다(플랫폼 주입값이 이긴다)", () => {
    const env = { DATABASE_URL: "postgres://dead-localhost", MYAPP_DATABASE_URL: "postgres://pooler" };
    expect(runtimeUrl(env)).toBe("postgres://pooler");
  });

  test("접두사 키가 없을 때만 generic DATABASE_URL을 쓴다(fallback)", () => {
    expect(runtimeUrl({ DATABASE_URL: "postgres://generic" })).toBe("postgres://generic");
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

  // 접두사 자리에 역할 이름만 들어온 꼴(MIGRATE_DATABASE_URL)도 런타임 후보가 아니다 —
  // 접두사 우선이 된 순간 이게 generic을 이기면 런타임이 풀러를 우회해 직결로 붙는다(공유 커넥션 고갈).
  test("접두사 없는 MIGRATE_/RO_ 키도 런타임 후보가 아니다", () => {
    const env = {
      MIGRATE_DATABASE_URL: "postgres://migrate",
      RO_DATABASE_URL: "postgres://ro",
      DATABASE_URL: "postgres://generic",
    };
    expect(runtimeUrl(env)).toBe("postgres://generic");
  });

  // 역할 제외는 '_ 경계'로만 끊는다 — 앱 이름이 ro/migrate로 끝나면(euro) 정상 키를 삼키면 안 된다.
  test("이름이 RO로 끝나는 앱(euro)의 접두사 키는 제외되지 않는다", () => {
    expect(runtimeUrl({ EURO_DATABASE_URL: "postgres://euro" })).toBe("postgres://euro");
  });

  // ★조용한 임의 선택 금지 — Object.keys 순서(삽입 순서)는 계약이 아니다. 어느 DB가 이 앱 것인지
  //   아는 주체가 아무 데도 없으므로 기동에서 죽인다(CrashLoop는 시끄럽고 되돌릴 수 있다;
  //   엉뚱한 DB에 쓰고도 초록인 상태는 되돌릴 수 없다).
  test("접두사 키가 둘 이상이면 던진다(임의로 고르지 않는다)", () => {
    const env = { B_DATABASE_URL: "postgres://b", A_DATABASE_URL: "postgres://a" };
    expect(() => runtimeUrl(env)).toThrow(/A_DATABASE_URL, B_DATABASE_URL/);
  });

  // 이 메시지는 계약이다 — seal-secret.mts의 경고가 "둘 다 필요하면 createApp(pool)로 우회하라"고 보내는
  // 곳이 여기다. 탈출구를 지우면 그 경고가 갈 곳 없는 조언이 된다(두 메시지가 한 이야기여야 한다).
  test("던지는 메시지가 탈출구(createApp(pool))를 가리킨다", () => {
    const env = { A_DATABASE_URL: "postgres://a", B_DATABASE_URL: "postgres://b" };
    expect(() => runtimeUrl(env)).toThrow(/createApp\(pool\)/);
  });

  test("빈 값은 후보가 아니다(generic으로 내려간다)", () => {
    expect(runtimeUrl({ MYAPP_DATABASE_URL: "", DATABASE_URL: "postgres://generic" })).toBe("postgres://generic");
  });

  test("DB 미설정 앱이면 undefined", () => {
    expect(runtimeUrl({ PATH: "/usr/bin", PORT: "8080" })).toBeUndefined();
  });
});
