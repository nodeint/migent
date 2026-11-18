import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import type { PluginEventProposal } from '@nodeint/migent-contracts';
import { writeFileAtomic } from '@nodeint/migent-kernel';
import { assertSessionLockHeld } from '@nodeint/migent-session';

/**
 * Writes the artifact proposal under `plugins/<id>/`. A filesystem failure is a plugin failure, not a host
 * failure, so it goes through the failure policy and the next plugin still runs. Only session-log errors propagate.
 */
export function writePluginArtifact(
  directory: string,
  artifact: {
    readonly pluginId: string;
    readonly proposal: Extract<PluginEventProposal, { kind: 'artifact' }>;
    readonly mode: 'create_only' | 'replace';
  },
): { readonly result: Record<string, unknown> } | { readonly error: string } {
  assertSessionLockHeld(directory);
  const { pluginId, proposal, mode } = artifact;
  const relative = path.posix.join('plugins', pluginId, proposal.name);
  const target = path.join(directory, relative);
  if (mode === 'create_only' && existsSync(target)) {
    return { result: { kind: 'artifact', status: 'rejected', reason: 'exists', path: relative } };
  }
  try {
    mkdirSync(path.join(directory, 'plugins', pluginId), { recursive: true });
    writeFileAtomic(target, proposal.content);
  } catch (caught) {
    return { error: `Could not write ${relative}: ${caught instanceof Error ? caught.message : String(caught)}` };
  }
  return {
    result: {
      kind: 'artifact', status: 'applied', path: relative,
      sha256: createHash('sha256').update(proposal.content).digest('hex'),
    },
  };
}
