import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "cloudfunctions/**/*.test.ts", "miniprogram/**/*.test.ts", "tests/**/*.test.ts", "tests/**/*.test.mjs"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
    maxWorkers: 4,
  },
});
