import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nodeint/migent-contracts": path.join(root, "packages/contracts/src/index.ts"),
      "@nodeint/migent-adapters": path.join(root, "packages/adapters/src/index.ts"),
      "@nodeint/migent-prompts": path.join(root, "packages/prompts/src/index.ts"),
      "@nodeint/migent-doctor": path.join(root, "packages/doctor/src/index.ts"),
      "@nodeint/migent-kernel": path.join(root, "packages/kernel/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "integration/**/*.test.ts"],
    // Windows runners start processes and touch files more slowly.
    testTimeout: process.platform === "win32" ? 30_000 : 10_000,
    reporters: [["dot", { summary: false }]],
    silent: true,
    setupFiles: ["scripts/vitest-quiet-setup.ts"],
  },
});
