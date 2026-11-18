import { createHash } from 'node:crypto';

import type { PluginManifest, PluginResumeFacts, PluginSessionSnapshot } from '@nodeint/migent-contracts';

/**
 * What one `call.session` read returned, captured by the core. The plugin supplies none of it, so it cannot
 * claim a basis it did not read (D10).
 */
export type ReadEvidence =
  | { readonly kind: 'snapshot'; readonly basisSeq: number | null }
  | { readonly kind: 'resume_facts'; readonly executionId: string; readonly hash: string };

/** The core's session reads. The context records their results, and the freshness check repeats them. */
export interface SessionReads {
  snapshot(): PluginSessionSnapshot;
  resumeFacts(executionId: string): PluginResumeFacts;
  /** The last non-`plugin.*` event seq now. */
  basis(): number | null;
}

export const hashFacts = (facts: PluginResumeFacts): string =>
  createHash('sha256').update(JSON.stringify(facts)).digest('hex');

/**
 * Whether anything an invocation read has changed. A `resumeFacts` read counts only when that execution's returned
 * facts changed. A `snapshot` read counts any later non-plugin event, because it covers the whole session.
 */
export function readsStale(reads: SessionReads, evidence: readonly ReadEvidence[]): boolean {
  for (const item of evidence) {
    if (item.kind === 'snapshot') {
      if (reads.basis() !== item.basisSeq) return true;
    } else if (hashFacts(reads.resumeFacts(item.executionId)) !== item.hash) return true;
  }
  return false;
}

/**
 * What an event handler's result depends on: its own reads, plus the invocation start as an implicit snapshot
 * basis when it proposes an artifact of a `fresh` claim, even if it read nothing.
 */
export function freshEvidence(
  plugin: { readonly manifest: PluginManifest },
  raw: unknown,
  captured: { readonly read: readonly ReadEvidence[]; readonly startBasis: number | null },
): readonly ReadEvidence[] {
  if (!Array.isArray(raw)) return captured.read;
  const claims = plugin.manifest.uses.artifacts.filter((claim) => claim.fresh === true);
  const fresh = new Set(claims.map((claim) => claim.name));
  const proposes = raw.some((item: { kind?: unknown; name?: unknown } | null) =>
    item?.kind === 'artifact' && typeof item.name === 'string' && fresh.has(item.name));
  return proposes ? [...captured.read, { kind: 'snapshot', basisSeq: captured.startBasis }] : captured.read;
}
