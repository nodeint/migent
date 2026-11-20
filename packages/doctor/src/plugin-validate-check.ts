import { type ClientRegistry, type ConfigOwner, type PluginRegistry, pluginValidationProblems } from '@nodeint/migent-kernel';

import { type DiagnosticList } from './check.js';

/**
 * Reports what the registered plugins' `validate` members find in the effective config (plugin API 1.1), as errors
 * at the reported path with its config layer. The code stays `resume-policy-invalid` for the prompt cache plugin.
 */
export function checkPluginValidation(
  config: Record<string, unknown>,
  registry: PluginRegistry | undefined,
  report: {
    readonly clients: ClientRegistry;
    readonly diagnostics: DiagnosticList;
    readonly ownerOf: (path: readonly (string | number)[]) => ConfigOwner;
  },
): void {
  if (registry === undefined) return;
  for (const problem of pluginValidationProblems(registry, config, { clients: report.clients })) {
    // The manifest schema may already have reported the field; the plugin's code replaces it.
    report.diagnostics.replaceErrorAt({
      severity: 'error',
      code: problem.plugin === 'prompt_cache_ttl' ? 'resume-policy-invalid' : 'plugin-invalid',
      message: problem.message,
      path: problem.path,
      source: { layer: report.ownerOf(problem.path) },
    });
  }
}
