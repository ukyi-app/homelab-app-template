import { expect, test } from "bun:test";
import { handle } from "./server";

test("/healthz는 200 ok", async () => {
  const res = handle(new Request("http://app/healthz"));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("ok");
});
