import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createApp } from "./index";

// 서버 기동 없이(엔트리 가드 덕에) app.fetch로만 라우트를 검증한다.
// 여기서 지키는 건 "핸들러가 상수를 돌려주는가"가 아니라 라우트 등록 순서다 — probe·API가
// SPA catch-all보다 뒤로 밀리면 /healthz가 index.html(200)을 돌려주고 k8s는 죽은 파드를 살아있다고 본다.
const app = createApp();

// catch-all(serveStatic)은 파일이 없으면 next()로 흘려보내 순서 회귀를 감춘다 — 빌드 산출물을
// 흉내 내야 catch-all이 실제로 살아나고 테스트가 falsifiable해진다(테스트는 빌드 前에 돈다).
const INDEX_HTML = "web/dist/index.html";
const stubbed = !existsSync(INDEX_HTML);
beforeAll(() => {
  if (stubbed) {
    mkdirSync("web/dist", { recursive: true });
    writeFileSync(INDEX_HTML, '<!doctype html><div id="root"></div>');
  }
});
afterAll(() => {
  if (stubbed) rmSync(INDEX_HTML, { force: true });
});

describe("routes", () => {
  test("liveness는 SPA catch-all에 가로채이지 않는다", async () => {
    const res = await app.fetch(new Request("http://app/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("readiness는 SPA catch-all에 가로채이지 않는다", async () => {
    const res = await app.fetch(new Request("http://app/readyz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ready");
  });

  test("예제 API는 SPA catch-all에 가로채이지 않는다", async () => {
    const res = await app.fetch(new Request("http://app/api/hello"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: "Hello from Hono" });
  });

  test("그 외 경로는 SPA index.html로 폴백(클라이언트 라우팅)", async () => {
    const res = await app.fetch(new Request("http://app/some/client/route"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
  });
});
