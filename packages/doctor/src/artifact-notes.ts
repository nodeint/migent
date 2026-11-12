import type { WorkflowDocument } from '@nodeint/migent-workflow';

/** Code of the informational finding for a downstream mapping to an optional artifact. */
export const OPTIONAL_MAPPING_CODE = 'downstream-optional-artifact';

export interface OptionalMapping {
  /** Index of the downstream entry. */
  entry: number;
  /** Destination context name. */
  name: string;
  /** Artifact id the name maps to. */
  artifact: string;
  message: string;
  path: (string | number)[];
}

/**
 * Downstream mappings whose value is an artifact declared `required: false`. The target receives
 * such a file only when it was produced, so authors are told the context is best-effort. Shared by
 * draft validation, project doctor and session doctor so every path reports the same finding.
 */
export function optionalArtifactMappings(
  document: Pick<WorkflowDocument, 'artifacts' | 'downstream'>,
): OptionalMapping[] {
  const optional = new Set(
    (document.artifacts ?? []).filter((artifact) => !artifact.required).map((artifact) => artifact.id),
  );
  const found: OptionalMapping[] = [];
  (document.downstream ?? []).forEach((entry, index) => {
    for (const [name, artifact] of Object.entries(entry.artifacts ?? {})) {
      if (!optional.has(artifact)) continue;
      found.push({
        entry: index,
        name,
        artifact,
        message: `downstream.artifacts.${name} maps to optional artifact ${artifact}; the target receives it only when it was produced.`,
        path: ['downstream', index, 'artifacts', name],
      });
    }
  });
  return found;
}
