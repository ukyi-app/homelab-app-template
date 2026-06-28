import { expect, test } from "bun:test";
import { tick } from "./index";

test("worker tick is deterministic for a provided timestamp", () => {
  expect(tick(new Date("2026-01-01T00:00:00.000Z"))).toBe("worker tick 2026-01-01T00:00:00.000Z");
});
