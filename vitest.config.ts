import { defineConfig } from "vitest/config";

export default defineConfig({
  // The web UI uses Preact's JSX.
  esbuild: { jsx: "automatic", jsxImportSource: "preact" },
  test: {
    include: [
      "packages/*/test/**/*.test.ts",
      "packages/*/test/**/*.test.tsx",
      // The differential updates' packer (G36.18).
      "packaging/update/test/*.test.ts",
    ],
    // In-process Postgres and git worktrees make some integration tests take seconds.
    testTimeout: 30_000,
    setupFiles: ["./vitest.setup.ts"],
    // Live tests call real models; they run only with `pnpm test:live`.
    exclude: ["**/node_modules/**", "**/*.live.test.ts", "**/*.docker.test.ts"],
  },
});
