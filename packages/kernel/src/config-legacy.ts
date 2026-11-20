import type { Field } from './config-structure.js';
import { ConfigurationError } from './errors.js';

/** Agent keys removed by earlier schema versions point at `migent migrate`. */
export function refuseLegacyAgentKeys(agentConfig: Record<string, unknown>, { label, path }: Field): void {
  if (Object.hasOwn(agentConfig, 'options')) {
    throw new ConfigurationError(
      `${label}.options moved to ${label}.client.options. Run \`migent migrate\`.`,
      { code: 'agent-options-moved', path: [...path, 'options'] },
    );
  }
  if (Object.hasOwn(agentConfig, 'resume_policy')) {
    throw new ConfigurationError(
      `${label}.resume_policy moved to ${label}.prompt_cache_ttl.policy in schema_version 8. Run \`migent migrate\`.`,
      { code: 'legacy-key', path: [...path, 'resume_policy'] },
    );
  }
  if (Object.hasOwn(agentConfig, 'provider')) {
    throw new ConfigurationError(
      `${label}.provider was removed in schema_version 6; set ${label}.client.type. Run \`migent migrate\`.`,
      { code: 'legacy-key', path: [...path, 'provider'] },
    );
  }
}


/** A v4 top-level key in a current document names its v5 replacement. */
export function rejectLegacyConfigKeys(config: Record<string, unknown>): void {
  if (Object.hasOwn(config, 'resume_policies')) {
    throw new ConfigurationError(
      'resume_policies moved to plugins.prompt_cache_ttl.policies in schema_version 8. Run `migent migrate`.',
      { code: 'legacy-key', path: ['resume_policies'] },
    );
  }
  if (Object.hasOwn(config, 'models')) {
    throw new ConfigurationError('models was renamed to agents in schema_version 5. Run `migent migrate`.', {
      code: 'legacy-key',
      path: ['models'],
    });
  }
}

/** Keys a role no longer accepts, each with the v5 key that replaces it. */
export function validateRoleKeys(role: Record<string, unknown>, roleKey: string): void {
  if (Object.hasOwn(role, 'options')) {
    throw new ConfigurationError(
      `roles.${roleKey}.options is no longer supported. Move options into roles.${roleKey}.agent (inline agent) or the referenced agents entry, under client.options.`,
      { code: 'role-options-unsupported', path: ['roles', roleKey, 'options'] },
    );
  }
  for (const [old, replacement] of [['default_model', 'agent'], ['instructions', 'responsibilities']] as const) {
    if (Object.hasOwn(role, old)) {
      throw new ConfigurationError(
        `roles.${roleKey}.${old} was renamed to roles.${roleKey}.${replacement} in schema_version 5. Run \`migent migrate\`.`,
        { code: 'legacy-key', path: ['roles', roleKey, old] },
      );
    }
  }
}
