import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { sessionDiagnosticsCheck } from "../src/index.ts";

test("reports the latest recorded diagnostics per stage as warnings", () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "migent-diag-"));
  try {
    const executions = path.join(workspace, ".migent", "sessions", "s1", "executions");
    const write = (id: string, order: number, message: string) => {
      mkdirSync(path.join(executions, id), { recursive: true });
      writeFileSync(path.join(executions, id, "execution.json"), JSON.stringify({ stage_id: "plan", execution_order: order }));
      writeFileSync(
        path.join(executions, id, "diagnostics.json"),
        JSON.stringify({ failure: { kind: "start", phase: "listen", code: "EACCES", message }, stderr_tail: "a\nb\n" }),
      );
    };
    write("e1", 1, "old");
    write("e2", 2, "new");
    const check = sessionDiagnosticsCheck(workspace, "s1");
    expect(check.ok).toBe(true);
    expect(check.warnings).toHaveLength(1);
    expect(check.warnings[0]).toContain("new");
    expect(check.warnings[0]).toContain("code=EACCES");
    expect(check.warnings[0]).toContain("stderr: b");
    expect(check.warnings[0]).toContain("executions/e2/diagnostics.json");
    expect(sessionDiagnosticsCheck(workspace, "none").items).toEqual(["No recorded provider diagnostics."]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
