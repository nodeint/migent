import { loadWorkflowCatalog, whichSync, type ClientRegistry, type SessionSelection } from "@nodeint/migent-kernel";
import type { ModelEffortCheck } from "./check.js";
import type { RunCommand, Which } from "./catalog.js";
import { diagnose } from "./diagnose.js";
import { checkModels } from "./model-check.js";
import { diagnoseSession, sessionEffortKeys, type SessionDiagnosis } from "./session.js";
import { stageAgentDefinitions } from "./stage-agents.js";
import type { Check } from "./check.js";

export interface DiagnoseHooks {
  clients: ClientRegistry;
  /** Defaults to the real PATH lookup. */
  which?: Which | null;
  /** Reads client catalogs. Without it models are not looked up. */
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
  const which = hooks.which ?? whichSync;
  let modelEffortChecks: Record<string, ModelEffortCheck> = {};
  const keys = sessionEffortKeys(workspace, selection);
  if (keys.size > 0 && hooks.runCommand != null) {
    const extra = selection.document === null ? [] : stageAgentDefinitions([selection.document]);
    modelEffortChecks = await checkModels(workspace, hooks.clients, which, hooks.runCommand, keys, extra);
  }
  return diagnoseSession(workspace, selection, { clients: hooks.clients, which, modelEffortChecks });
}

/** The checks of `migent doctor`: config, workflows and clients, with every model looked up. */
export async function diagnoseWorkspace(workspace: string, hooks: DiagnoseHooks & { runCommand: RunCommand }): Promise<Check[]> {
  const which = hooks.which ?? whichSync;
  const documents = Object.values(loadWorkflowCatalog(workspace, { quiet: true }).documents);
  const modelEffortChecks = await checkModels(workspace, hooks.clients, which, hooks.runCommand, undefined, stageAgentDefinitions(documents));
  return diagnose(workspace, { clients: hooks.clients, which, modelEffortChecks });
}
