import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    // Live tests call real models; they run only with `pnpm test:live`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts", "**/*.docker.test.ts"],
  },
});
