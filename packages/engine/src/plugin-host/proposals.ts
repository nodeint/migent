import { isValid, PluginEventProposal } from '@nodeint/migent-contracts';

import type { PluginFailure } from './holds.js';
import type { SelectedPlugin } from './selection.js';

/** A safe output file name: one path segment, no separators, no leading dot, no `..`. */
const SAFE_OUTPUT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

export function isSafeOutputName(name: string): boolean {
  return SAFE_OUTPUT_NAME.test(name) && !name.includes('..');
}

export type ProposalFailure = { readonly kind: 'fail'; readonly reason: PluginFailure['reason']; readonly error: string };

/**
 * Validates every proposal of one invocation. Any invalid entry rejects the whole invocation. At most one
 * artifact is allowed, and it must match a `uses.artifacts` claim.
 */
export function validateProposals(
  plugin: SelectedPlugin,
  raw: unknown,
): { readonly proposals: readonly PluginEventProposal[] } | ProposalFailure {
  const invalid = (error: string): ProposalFailure => ({ kind: 'fail', reason: 'invalid_intent', error });
  if (!Array.isArray(raw)) return invalid('The hook must return an array of proposals.');
  const proposals: PluginEventProposal[] = [];
  for (const [index, item] of raw.entries()) {
    if (!isValid(PluginEventProposal, item)) return invalid(`Proposal ${index} is not a valid plugin proposal.`);
    if (item.kind === 'artifact') {
      if (proposals.some((earlier) => earlier.kind === 'artifact')) {
        return invalid('An invocation may propose at most one artifact.');
      }
      if (!isSafeOutputName(item.name)) {
        return invalid(`Proposal ${index} has an unsafe artifact name: ${JSON.stringify(item.name)}.`);
      }
      if (!plugin.manifest.uses.artifacts.some((claim) => claim.name === item.name)) {
        return invalid(`Proposal ${index} names artifact "${item.name}", which uses.artifacts does not declare.`);
      }
    }
    proposals.push(item);
  }
  return { proposals };
}
