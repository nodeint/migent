import type { PluginValidationInput, PluginValidationProblem } from '@nodeint/migent-contracts';

/** Pure: a trigger listed twice is reported as `plugins.summarizer.triggers[<i>]`. Unknown values fail the schema. */
export function validateTriggers(input: PluginValidationInput): readonly PluginValidationProblem[] {
  const { triggers } = input.options;
  if (!Array.isArray(triggers)) return [];
  const seen = new Set<unknown>();
  const problems: PluginValidationProblem[] = [];
  for (const [index, value] of triggers.entries()) {
    if (seen.has(value)) {
      const path = `plugins.summarizer.triggers[${index}]`;
      problems.push({ path, message: `${path} lists "${String(value)}" more than once.` });
    }
    seen.add(value);
  }
  return problems;
}
