import { expect, it } from "vitest";

import { formatUtcInstant } from "./time";

it("将带时区瞬时时间统一成 UTC 毫秒格式", () => {
  expect(formatUtcInstant(new Date("2026-01-01T00:00:00+08:00"))).toBe("2025-12-31T16:00:00.000Z");
});

it.each([new Date("invalid"), new Date("+010000-01-01T00:00:00.000Z")])("拒绝无法按契约表示的日期 %s", (date) => {
  expect(() => formatUtcInstant(date)).toThrow();
});
