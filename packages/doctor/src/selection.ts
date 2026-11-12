import { type ClientRegistry,whichSync } from '@nodeint/migent-kernel';
import { type SessionSelection } from '@nodeint/migent-session';
import { loadWorkflowCatalog } from '@nodeint/migent-workflow';

import type { RunCommand, Which } from './catalog.js';
import type { ModelEffortCheck } from './check.js';
import type { Check } from './check.js';
import { diagnose } from './diagnose.js';
import { checkModels } from './model-check.js';
import { collectNativeOptionFacts, usedClientIds } from './native-options.js';
import { diagnoseSession, type SessionDiagnosis,sessionEffortKeys } from './session.js';
import { stageAgentDefinitions } from './stage-agents.js';

export interface DiagnoseHooks {
  clients: ClientRegistry;
  /** Defaults to the real PATH lookup. */
  which?: Which | null;
  /** Reads client catalogs. Without it models are not looked up. */
  runCommand?: RunCommand | null;
  /** Reads client help, which some CLIs print on stderr. Defaults to `runCommand`. */
  helpCommand?: RunCommand | null;
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
  const extra = selection.document === null ? [] : stageAgentDefinitions([selection.document]);
  if (keys.size > 0 && (hooks.runCommand !== null && hooks.runCommand !== undefined)) {
    modelEffortChecks = await checkModels(
      workspace,
      hooks.clients,
      { which, runCommand: hooks.runCommand, only: keys, extra },
    );
  }
  const helpRun = hooks.helpCommand ?? hooks.runCommand;
  const nativeOptionFacts = helpRun === null || helpRun === undefined
    ? undefined
    : await collectNativeOptionFacts(hooks.clients, {
      which,
      runCommand: helpRun,
      // A frozen session validates the clients it pinned, whatever the live config says.
      only: usedClientIds(workspace, hooks.clients, {
        extra,
        pinned: Object.values(selection.freeze?.targets ?? {}).map((target) => target.client),
      }),
    });
  return diagnoseSession(workspace, selection, { clients: hooks.clients, which, modelEffortChecks, nativeOptionFacts });
}

/** The checks of `migent doctor`: config, workflows and clients, with every model looked up. */
export async function diagnoseWorkspace(
  workspace: string,
  hooks: DiagnoseHooks & { runCommand: RunCommand },
): Promise<Check[]> {
  const which = hooks.which ?? whichSync;
  const documents = Object.values(loadWorkflowCatalog(workspace, { quiet: true }).documents);
  const modelEffortChecks = await checkModels(
    workspace,
    hooks.clients,
    { which, runCommand: hooks.runCommand, extra: stageAgentDefinitions(documents) },
  );
  const nativeOptionFacts = await collectNativeOptionFacts(hooks.clients, {
    which,
    runCommand: hooks.helpCommand ?? hooks.runCommand,
    only: usedClientIds(workspace, hooks.clients, { extra: stageAgentDefinitions(documents) }),
  });
  return diagnose(workspace, { clients: hooks.clients, which, modelEffortChecks, nativeOptionFacts });
}
