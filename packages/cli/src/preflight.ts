import {
  diagnoseSelection as diagnose,
  type DiagnoseHooks as DoctorHooks,
  type SessionDiagnosis,
} from "@nodeint/migent-doctor";
import {
  readStatusFileState,
  selectRunWorkflow,
  selectSessionWorkflow,
  whichSync,
  type ClientRegistry,
  type SessionSelection,
} from "@nodeint/migent-kernel";
import path from "node:path";
import { printDoctor } from "./display.js";
import { cliHooks } from "./hooks.js";
import { runClientCommandAsync, type RunCommand, type Which } from "./client.js";

export interface DiagnoseHooks {
  clients: ClientRegistry;
  which?: Which | null;
  runCommand?: RunCommand | null;
}

/**
 * The checks `migent doctor --session` runs, shared with the preflight of `session run`.
 * Only the models the selected workflow uses are looked up.
 */
export async function diagnoseSelection(
  workspace: string,
  selection: SessionSelection,
  hooks: DiagnoseHooks,
): Promise<SessionDiagnosis> {
  const which = hooks.which ?? cliHooks.which ?? whichSync;
  const runCommand = hooks.runCommand ?? cliHooks.runCommand ??
    ((argv, input) => runClientCommandAsync(argv, input, { cwd: workspace, timeoutMs: 10_000 }));
  const resolved: DoctorHooks = { clients: hooks.clients, which, runCommand };
  return diagnose(workspace, selection, resolved);
}

export interface PreflightTarget {
  /** Workflow id or path of a session about to be created. */
  workflowId: string | null;
  /** Prepared session about to be started. */
  sessionId: string | null;
}

/**
 * Validates the whole workflow before a session is created or frozen. Writes to stderr only.
 * Returns false when a problem blocks the run; warnings never do.
 */
export async function runPreflight(workspace: string, target: PreflightTarget, hooks: DiagnoseHooks): Promise<boolean> {
  let selection: SessionSelection;
  if (target.sessionId !== null) {
    selection = selectSessionWorkflow(workspace, target.sessionId);
    const status = readStatusFileState(path.join(workspace, ".migent", "sessions", target.sessionId, "status.json"));
    // Anything but a prepared session is rejected by the run itself with its own message.
    if (selection.problems.length === 0 && !(status.state === "ok" && status.status.status === "prepared")) return true;
  } else if (target.workflowId !== null) {
    selection = selectRunWorkflow(workspace, target.workflowId);
  } else {
    return true;
  }
  const diagnosis = await diagnoseSelection(workspace, selection, hooks);
  if (!diagnosis.ok) {
    printDoctor(diagnosis.checks, process.stderr);
    process.stderr.write("Preflight failed: fix the problems above and run again, or pass --skip-preflight.\n");
    return false;
  }
  const warnings = diagnosis.checks.flatMap((check) => check.warnings);
  for (const warning of warnings) process.stderr.write(`preflight warning: ${warning.replaceAll("\n", "\n  ")}\n`);
  process.stderr.write("preflight ok\n");
  return true;
}
