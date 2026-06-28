import { expect, test } from "bun:test";
import server from "./index";

const request = (path: string) => server.fetch(new Request(`http://example.test${path}`));

test("service health endpoint uses /health", async () => {
  const res = await request("/health");

  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok" });
});

test("root endpoint responds", async () => {
  const res = await request("/");

  expect(res.status).toBe(200);
  expect(await res.text()).toBe("Hello homelab app!");
});
