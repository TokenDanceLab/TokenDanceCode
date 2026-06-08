import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tokendance/code-core": new URL("./packages/core/src/index.ts", import.meta.url).pathname,
      "@tokendance/code-sdk": new URL("./packages/sdk/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    include: ["packages/*/tests/**/*.test.ts"],
    pool: "threads"
  }
});
