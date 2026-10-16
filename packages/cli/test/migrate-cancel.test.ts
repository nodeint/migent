import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => value === "cancel",
  confirm: async () => "cancel",
  select: async () => "cancel",
  text: async () => "cancel",
}));

import { main } from "../src/index.ts";
import { capture } from "./support.ts";

const originalTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

afterEach(() => {
  if (originalTty) Object.defineProperty(process.stdin, "isTTY", originalTty);
});

test("migrate treats a cancelled prompt as a decline", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-cli-"));
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  try {
    const root = path.join(workspace, ".migent");
    mkdirSync(path.join(root, "workflows"), { recursive: true });
    const config = "models:\n  default:\n    provider: grok\n    model: grok-4\nroles:\n  developer:\n    default_model: default\n";
    writeFileSync(path.join(root, "config.yaml"), config, "utf8");
    writeFileSync(
      path.join(root, "workflows", "implement.yaml"),
      "id: implement\nstages:\n  - id: implement\n    role: developer\n    depends_on: []\n",
      "utf8",
    );
    const captured = await capture(() => main(["migrate"], workspace));
    expect(captured.value).toBe(0);
    expect(captured.stdout).toContain("Left unchanged.");
    expect(readFileSync(path.join(root, "config.yaml"), "utf8")).toBe(config);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
