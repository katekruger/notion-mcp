import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "json-summary"],
      // Just below the current numbers, so coverage can only go up. Raise them as tests are added.
      thresholds: { statements: 51, branches: 42, functions: 50, lines: 54 },
    },
  },
});
