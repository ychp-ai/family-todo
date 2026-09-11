import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "cloudfunctions/**/*.test.ts", "miniprogram/**/*.test.ts", "tests/**/*.test.ts"],
    clearMocks: true,
    restoreMocks: true,
    unstubGlobals: true,
  },
});
