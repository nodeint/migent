import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { runInit } from "../packages/cli/src/commands/init.ts";
import {
  APPROVED, COMPLETE, REVISE, PROVIDER_BIN, installScript, providerInvocations,
  removeWorkspace, runMain, tempWorkspace,
} from "./support.ts";

test.each([
  ["implement", false], ["implement", true], ["plan", false], ["plan", true],
] as const)("generated %s workflow completes through review (revise=%s)", async (workflow, revise) => {
  const workspace = tempWorkspace();
  try {
    expect(await runInit(workspace, {
      provider: "codex", model: "codex-test",
      reviewerProvider: "grok", reviewerModel: "grok-test",
      which: (command) => path.join(PROVIDER_BIN, command),
      runCommand: (argv) => argv[0] === "codex"
        ? JSON.stringify({ models: [{ slug: "codex-test", visibility: "list" }] })
        : "Available models:\n  - grok-test\n",
    })).toBe(0);
    const work = workflow === "plan"
      ? { text: COMPLETE, artifact: "# Implementation plan\n" }
      : { text: COMPLETE };
    installScript(workspace, revise
      ? [work, { text: REVISE }, work, { text: APPROVED }]
      : [work, { text: APPROVED }]);

    const [code, results, stderr] = await runMain(workspace, [
      "session", "run", "--workflow", workflow, "--task", "Add a JSON export flag",
    ]);
    expect(code, stderr).toBe(0);
    expect(results[0]?.session_status).toBe("completed");
    expect(providerInvocations(workspace).map((call) => call.provider))
      .toEqual(revise ? ["codex", "grok", "codex", "grok"] : ["codex", "grok"]);
    if (workflow === "plan") {
      const artifact = path.join(workspace, ".migent", "sessions", String(results[0]?.session_id), "outputs", "plan.md");
      expect(readFileSync(artifact, "utf8")).toContain("Implementation plan");
    }
  } finally {
    removeWorkspace(workspace);
  }
}, 30_000);
