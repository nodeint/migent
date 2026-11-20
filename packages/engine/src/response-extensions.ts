import path from 'node:path';

import { type TSchema, validationIssues } from '@nodeint/migent-contracts';
import type { ExtensionRule } from '@nodeint/migent-kernel';
import { RESPONSE_EXTENSIONS_PROTOCOL, type ResponseExtensionPrompt } from '@nodeint/migent-prompts';
import type { ExecutionContext } from '@nodeint/migent-session';
import { readWorkflowFreeze } from '@nodeint/migent-session';

/** The active response extensions of one stage, as the prompt lists them and as validation checks them. */
export interface StageExtensions {
  readonly prompts: readonly ResponseExtensionPrompt[];
  readonly rules: readonly ExtensionRule[];
}

const NONE: StageExtensions = { prompts: [], rules: [] };

/**
 * Built only from the stage's frozen `response_contracts` and only for protocol 4 or later, never from the live
 * catalog or plugin, so a resume prompts and validates with the values the session froze.
 */
export function stageExtensions(
  context: ExecutionContext,
  stageId: string,
  protocol: number,
): StageExtensions {
  if (protocol < RESPONSE_EXTENSIONS_PROTOCOL) return NONE;
  const contracts = readWorkflowFreeze(path.dirname(path.dirname(context.directory)))?.responseContracts[stageId];
  if (contracts === undefined) return NONE;
  const entries = Object.entries(contracts);
  return {
    prompts: entries.map(([key, contract]) => ({
      key, required: contract.required, instructions: contract.instructions, schema: JSON.stringify(contract.schema),
    })),
    rules: entries.map(([key, contract]) => ({
      key, required: contract.required, instructions: contract.instructions,
      check: (value) => validationIssues(contract.schema as TSchema, value),
    })),
  };
}
