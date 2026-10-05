import { expect, test } from "vitest";
import { KERNEL_PLACEHOLDER } from "../src/index.ts";

test("kernel exports a placeholder", () => {
  expect(KERNEL_PLACEHOLDER).toBe("kernel");
});
