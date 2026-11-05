import { checkModels } from "../model-check.js";
import { homedir } from "node:os";
import {
  diagnose,
  diagnoseSession,
  selectSessionWorkflow,
  sessionDiagnosticsCheck,
  sessionEffortKeys,
  whichSync,
  type Check,
  type SessionSource,
} from "@nodeint/migent-kernel";
import { printDoctor } from "../display.js";
import { cliHooks } from "../hooks.js";
import { requireCurrentSchema } from "../migrate.js";
import { providerMap, runProviderCommand, type RunCommand, type Which } from "../provider.js";
import { skillCheck } from "../skill-check.js";

export async function runDoctor(
  workspace: string,
  options: { asJson?: boolean; session?: string; which?: Which | null; home?: string; runCommand?: RunCommand } = {},
): Promise<number> {
  if (options.session !== undefined) return runSessionDoctor(workspace, options.session, options);
  requireCurrentSchema(workspace);
  const which = options.which ?? cliHooks.which ?? whichSync;
  const providers = providerMap();
  const runCommand = options.runCommand ?? cliHooks.runCommand ??
    ((argv, input) => runProviderCommand(argv, input, { cwd: workspace, timeoutMs: 10_000 }));
  const modelEffortChecks = await checkModels(workspace, providers, which, runCommand);
  const checks = [
    ...diagnose(workspace, { providers, which, modelEffortChecks }),
    skillCheck(workspace, options.home ?? homedir()),
  ];
  if (options.asJson) process.stdout.write(`${JSON.stringify(payload(checks))}\n`);
  else printDoctor(checks);
  return checks.every((check) => check.ok) ? 0 : 1;
}

function payload(checks: readonly Check[]): { ok: boolean; checks: Array<Record<string, unknown>> } {
  return {
    ok: checks.every((check) => check.ok),
    checks: checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      items: [...check.items],
      problems: [...check.problems],
      warnings: [...check.warnings],
    })),
  };
}

/** Validates the workflow one session runs. Read-only, and independent of the rest of the project. */
async function runSessionDoctor(
  workspace: string,
  sessionId: string,
  options: { asJson?: boolean; which?: Which | null; runCommand?: RunCommand },
): Promise<number> {
  const selection = selectSessionWorkflow(workspace, sessionId);
  const diagnostics = sessionDiagnosticsCheck(workspace, sessionId);
  // A role session has no workflow: the workflow check does not apply, diagnostics still do.
  if (selection.manifestWorkflowId === "agent") {
    const checks = [{ name: "Workflow", ok: true, items: ["Role session: no workflow to validate."], problems: [], warnings: [] }, diagnostics];
    if (options.asJson) process.stdout.write(`${JSON.stringify({ ...payload(checks), session: sessionPayload(sessionId, null) })}\n`);
    else printDoctor(checks);
    return 0;
  }
  // A freeze needs no live config, so only a live source requires a current config schema.
  if (selection.document !== null && selection.freeze === null) requireCurrentSchema(workspace, { configOnly: true });
  const which = options.which ?? cliHooks.which ?? whichSync;
  const providers = providerMap();
  let modelEffortChecks = {};
  const keys = sessionEffortKeys(workspace, selection);
  if (keys.size > 0) {
    const runCommand = options.runCommand ?? cliHooks.runCommand ??
      ((argv, input) => runProviderCommand(argv, input, { cwd: workspace, timeoutMs: 10_000 }));
    modelEffortChecks = await checkModels(workspace, providers, which, runCommand, keys);
  }
  const diagnosis = diagnoseSession(workspace, selection, { providers, which, modelEffortChecks });
  // Shown only when something was recorded, so a clean session prints what it always did.
  if (diagnostics.warnings.length > 0) diagnosis.checks.push(diagnostics);
  if (options.asJson) process.stdout.write(`${JSON.stringify({ ...payload(diagnosis.checks), session: sessionPayload(sessionId, diagnosis.source) })}\n`);
  else printDoctor(diagnosis.checks);
  return diagnosis.ok ? 0 : 1;
}

function sessionPayload(sessionId: string, source: SessionSource | null): Record<string, unknown> {
  return {
    id: sessionId,
    workflow_id: source?.workflowId ?? null,
    source: source?.kind ?? null,
    path: source?.path ?? null,
  };
}
