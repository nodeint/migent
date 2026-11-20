import type { PluginResponseContract, PluginResponseContractInput } from '@nodeint/migent-contracts';

interface Target {
  workflow: string;
  task: string;
}

function targetsOf(input: PluginResponseContractInput): Target[] {
  const list = input.workflow.downstream;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) => {
    const { workflow, task } = (entry ?? {}) as Record<string, unknown>;
    return typeof workflow === 'string' ? [{ workflow, task: typeof task === 'string' ? task : '' }] : [];
  });
}

/** Pure: asks every stage of a workflow with `downstream` for one recommendation. `null` without `downstream`. */
export function nextResponseContract(input: PluginResponseContractInput): PluginResponseContract | null {
  const targets = targetsOf(input);
  if (targets.length === 0) return null;
  const lines = targets.map((target) => `- \`${target.workflow}\`: ${target.task}`);
  const instructions = [
    'Recommend which downstream workflow should run next, based on the work done so far.',
    'Set `workflow` to exactly one of these ids:',
    ...lines,
    'Set `workflow` to `null` to abstain when none of them fits.',
    'Set `reason` to one short line that explains the choice or the abstention.',
  ].join('\n');
  return { required: true, instructions };
}
