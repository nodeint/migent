import { type ConfigOwner, ConfigurationError, listAgentDefinitions, selectResumePolicy, validateResumePolicies } from '@nodeint/migent-kernel';

import { type DiagnosticList } from './check.js';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Path = readonly (string | number)[];

/** The client type and model an agent definition names, when it names them as plain values. */
function agentTarget(definition: Record<string, unknown>): { client: string; model: string } {
  const client = isRecord(definition.client) ? definition.client.type : definition.client;
  return {
    client: typeof client === 'string' ? client : '',
    model: typeof definition.model === 'string' ? definition.model : '',
  };
}

/**
 * Reports the `resume_policies` mapping and every agent's `resume_policy` choice: a malformed policy, an unknown
 * name, and an agent that matches more than one policy. `ownerOf` gives each path its config layer.
 */
export function checkResumePolicies(
  config: Record<string, unknown>,
  diagnostics: DiagnosticList,
  ownerOf: (path: Path) => ConfigOwner,
): void {
  const add = (message: string, path: Path, code = 'resume-policy-invalid'): void => {
    diagnostics.add({ severity: 'error', code, message, path, source: { layer: ownerOf(path) } });
  };
  const problems = validateResumePolicies(config);
  for (const problem of problems) add(problem.message, ['resume_policies']);
  if (problems.length > 0) return;
  for (const entry of listAgentDefinitions(config)) {
    if (!isRecord(entry.value)) continue;
    const failure = selectionFailure(config, entry.value);
    if (failure !== null) add(`${entry.field}: ${failure}`, [...entry.path, ...(entry.value.resume_policy === undefined ? [] : ['resume_policy'])]);
  }
}

/** The configuration error selecting this agent's policy raises, or null when it selects cleanly. */
function selectionFailure(config: Record<string, unknown>, agent: Record<string, unknown>): string | null {
  const named = agent.resume_policy;
  try {
    selectResumePolicy(config.resume_policies as Record<string, unknown> | undefined, {
      agentPolicy: typeof named === 'string' && named.trim() !== '' ? named : null,
      ...agentTarget(agent),
    });
    return null;
  } catch (caught) {
    if (!(caught instanceof ConfigurationError)) throw caught;
    return caught.message;
  }
}
