import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nodeint/migent-adapters": path.join(root, "packages/adapters/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "integration/**/*.test.ts"],
  },
});
